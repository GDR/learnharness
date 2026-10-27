/**
 * Pure Obsidian Markdown AST & Feature Parser.
 *
 * Implements full AST extraction and character offset anchoring for Obsidian notes:
 * - YAML frontmatter extraction and parsing via js-yaml
 * - Headings (depths 1–6) with slugs and ancestor hierarchy tracking
 * - Structural hierarchical sections with nested blocks
 * - Fenced code blocks with language tagging
 * - Markdown tables (GFM table AST nodes)
 * - LaTeX math: inline ($...$) and block ($$...$$)
 * - Wiki-links: [[target]], [[target|alias]], [[target#heading]], [[target#^block-id]]
 * - Block references: ^block-id at block boundaries
 * - Tags: frontmatter tags and body tags (#tag, #nested/tag), excluding numbers and code/math
 * - Callouts: > [!type] Title with fold markers (+/-) and nested callouts
 *
 * All parsed entities carry exact 0-based character offsets (startOffset, endOffset)
 * faithful to the raw input string.
 */

// @ts-expect-error js-yaml does not bundle TypeScript type declarations
import yaml from "js-yaml";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { mathFromMarkdown } from "mdast-util-math";
import { gfm } from "micromark-extension-gfm";
import { math } from "micromark-extension-math";

import type {
	ParsedBlock,
	ParsedBlockKind,
	ParsedCallout,
	ParsedCalloutFold,
	ParsedEquation,
	ParsedHeading,
	ParsedObsidianDocument,
	ParsedSection,
	ParsedTable,
	ParsedTag,
	ParsedWikiLink,
	TextRange,
} from "../contracts/obsidian.ts";
import { validateParsedObsidianDocument } from "../contracts/obsidian.ts";

/**
 * Generates a clean URL slug from heading text, preserving Unicode letters/numbers.
 */
export function slugifyHeading(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) return "heading";
	const normalized = trimmed
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s_-]/gu, "")
		.trim()
		.replace(/\s+/g, "-")
		.replace(/^-+|-+$/g, "");
	return normalized || "heading";
}

/**
 * Recursively extracts plain text from an mdast node and its descendants.
 */
function extractNodeText(node: unknown): string {
	if (!node || typeof node !== "object") return "";
	const n = node as { value?: unknown; children?: unknown[] };
	if (typeof n.value === "string") return n.value;
	if (Array.isArray(n.children)) {
		return n.children.map(extractNodeText).join("");
	}
	return "";
}

/**
 * Checks whether an offset range overlaps with any excluded ranges.
 */
function isOverlapping(start: number, end: number, excluded: readonly TextRange[]): boolean {
	for (const range of excluded) {
		if (start < range.endOffset && end > range.startOffset) {
			return true;
		}
	}
	return false;
}

interface MdastPosition {
	start: { offset: number };
	end: { offset: number };
}

interface MdastNode {
	type: string;
	depth?: number;
	lang?: string | null;
	value?: string;
	children?: MdastNode[];
	position?: MdastPosition;
}

/**
 * Pure parser for Obsidian Markdown documents.
 *
 * @param markdown The raw Markdown string to parse.
 * @param filePath Optional file path of the source note.
 * @returns ParsedObsidianDocument with all extracted features and character offsets.
 */
export function parseObsidianMarkdown(
	markdown: string,
	filePath?: string,
): ParsedObsidianDocument {
	const headings: ParsedHeading[] = [];
	const blocks: ParsedBlock[] = [];
	const wikiLinks: ParsedWikiLink[] = [];
	const tags: ParsedTag[] = [];
	const callouts: ParsedCallout[] = [];
	const equations: ParsedEquation[] = [];
	const tables: ParsedTable[] = [];

	let frontmatter: Record<string, unknown> = {};
	let frontmatterRange: TextRange | undefined;

	// 1. Extract YAML Frontmatter: ^---\r?\n([\s\S]*?\r?\n)?---(?:\r?\n|$)
	const fmMatch = markdown.match(/^---\r?\n([\s\S]*?\r?\n)?---(?:\r?\n|$)/);
	if (fmMatch) {
		const rawYaml = fmMatch[1] ?? "";
		frontmatterRange = {
			startOffset: 0,
			endOffset: fmMatch[0].length,
		};

		if (rawYaml.trim().length > 0) {
			try {
				const parsedYaml = yaml.load(rawYaml);
				if (parsedYaml && typeof parsedYaml === "object" && !Array.isArray(parsedYaml)) {
					frontmatter = parsedYaml as Record<string, unknown>;
				}
			} catch {
				// Resilient to malformed YAML: preserve empty frontmatter while keeping offset
				frontmatter = {};
			}
		} else {
			frontmatter = {};
		}

		// Extract tags from frontmatter metadata
		if (frontmatter.tags !== undefined) {
			const rawTags = frontmatter.tags;
			const tagList: string[] = [];
			if (Array.isArray(rawTags)) {
				for (const item of rawTags) {
					if (typeof item === "string" || typeof item === "number") {
						tagList.push(String(item));
					}
				}
			} else if (typeof rawTags === "string") {
				tagList.push(...rawTags.split(/[\s,]+/));
			}

			for (const t of tagList) {
				const cleaned = t.trim().replace(/^#+/, "");
				if (cleaned.length > 0) {
					tags.push({
						name: cleaned,
						source: "frontmatter",
						range: frontmatterRange,
					});
				}
			}
		}
	}

	// 2. Prepare masked text for mdast AST parsing
	// Masking frontmatter characters with spaces preserves exact character offsets
	// without altering line breaks or node positions in mdast.
	let masked = markdown;
	if (frontmatterRange) {
		const fmEnd = frontmatterRange.endOffset;
		masked = markdown.slice(0, fmEnd).replace(/[^\r\n]/g, " ") + markdown.slice(fmEnd);
	}

	// Mask trailing block references after closing $$ in block math (e.g. `$$ ^eq1`)
	// micromark-extension-math expects closing $$ on its own line; replacing `^id` with
	// spaces allows clean parsing while keeping character offsets faithful.
	masked = masked.replace(
		/(\$\$[ \t]*)(\^[a-zA-Z0-9_-]+)/g,
		(_m, p1: string, p2: string) => p1 + " ".repeat(p2.length),
	);

	// 3. Build mdast AST with GFM and Math extensions
	const tree = fromMarkdown(masked, {
		extensions: [gfm(), math()],
		mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
	}) as MdastNode;

	// Collect ranges of code and math to exclude from wiki-link and body tag matching
	const codeAndMathRanges: TextRange[] = [];
	if (frontmatterRange) {
		codeAndMathRanges.push(frontmatterRange);
	}

	// 4. Recursive traversal to collect all AST elements (equations, callouts, tables, code spans)
	function walk(node: MdastNode): void {
		if (!node || !node.position) return;
		const range: TextRange = {
			startOffset: node.position.start.offset,
			endOffset: node.position.end.offset,
		};

		if (node.type === "code" || node.type === "inlineCode") {
			codeAndMathRanges.push(range);
		} else if (node.type === "math") {
			codeAndMathRanges.push(range);
			equations.push({
				type: "block",
				content: (node.value ?? "").trim(),
				range,
			});
		} else if (node.type === "inlineMath") {
			codeAndMathRanges.push(range);
			equations.push({
				type: "inline",
				content: (node.value ?? "").trim(),
				range,
			});
		} else if (node.type === "table") {
			// Extract GFM table rows
			const rows: string[][] = [];
			let header: string[] = [];
			if (Array.isArray(node.children)) {
				for (let i = 0; i < node.children.length; i++) {
					const rowNode = node.children[i];
					const cells: string[] = [];
					if (rowNode?.children && Array.isArray(rowNode.children)) {
						for (const cellNode of rowNode.children) {
							cells.push(extractNodeText(cellNode).trim());
						}
					}
					if (i === 0) {
						header = cells;
					} else {
						rows.push(cells);
					}
				}
			}
			tables.push({
				header,
				rows,
				range,
			});
		} else if (node.type === "blockquote") {
			// Check if blockquote is an Obsidian callout
			const rawSlice = markdown.slice(range.startOffset, range.endOffset);
			const calloutMatch = rawSlice.match(
				/^>(?:[ \t]*>)*[ \t]*\[!([a-zA-Z0-9_\-]+)\]([+-]?)(?:[ \t]+([^\r\n]*))?/,
			);
			if (calloutMatch && calloutMatch[1]) {
				const foldRaw = calloutMatch[2];
				const fold: ParsedCalloutFold | undefined =
					foldRaw === "+" || foldRaw === "-" ? foldRaw : undefined;
				const titleRaw = calloutMatch[3]?.trim();
				callouts.push({
					type: calloutMatch[1].toLowerCase(),
					fold,
					title: titleRaw && titleRaw.length > 0 ? titleRaw : undefined,
					range,
				});
			}
		}

		if (Array.isArray(node.children)) {
			for (const child of node.children) {
				walk(child);
			}
		}
	}

	walk(tree);

	// 5. Build Top-Level Blocks & Headings
	const rootChildren = tree.children ?? [];
	for (const node of rootChildren) {
		if (!node.position) continue;
		const range: TextRange = {
			startOffset: node.position.start.offset,
			endOffset: node.position.end.offset,
		};
		const rawText = markdown.slice(range.startOffset, range.endOffset);

		// Determine block reference ID if present at block tail (^block-id)
		const blockIdMatch = rawText.match(/(?:^|\s)\^([a-zA-Z0-9_-]+)\s*$/);
		const id = blockIdMatch ? blockIdMatch[1] : undefined;

		let kind: ParsedBlockKind = "paragraph";

		if (node.type === "heading") {
			kind = "heading";
			const text = extractNodeText(node).trim();
			const level = Math.max(1, Math.min(6, node.depth ?? 1));
			const slug = slugifyHeading(text);
			headings.push({
				level,
				text,
				slug,
				range,
			});
		} else if (node.type === "code") {
			kind = "code";
		} else if (node.type === "table") {
			kind = "table";
		} else if (node.type === "math") {
			kind = "math";
		} else if (node.type === "blockquote") {
			const rawSlice = markdown.slice(range.startOffset, range.endOffset);
			const isCallout = /^>[ \t]*\[!([a-zA-Z0-9_\-]+)\]/.test(rawSlice);
			kind = isCallout ? "callout" : "paragraph";
		} else if (node.type === "list") {
			kind = "list";
		} else {
			kind = "paragraph";
		}

		blocks.push({
			id,
			kind,
			range,
			rawText,
		});
	}

	// 6. Extract Wiki-links: [[target|alias]], [[target#heading]], [[target#^block-id]]
	const wikilinkRegex = /\[\[([^\]|#\^]+)?(?:#(\^)?([^\]|]+))?(?:\|([^\]]+))?\]\]/g;
	let wlMatch: RegExpExecArray | null;
	while ((wlMatch = wikilinkRegex.exec(markdown)) !== null) {
		const matchStart = wlMatch.index;
		const matchEnd = matchStart + wlMatch[0].length;

		if (isOverlapping(matchStart, matchEnd, codeAndMathRanges)) {
			continue;
		}

		const target = (wlMatch[1] ?? "").trim();
		const isBlock = Boolean(wlMatch[2]);
		const subpathVal = wlMatch[3]?.trim();
		const alias = wlMatch[4]?.trim();

		wikiLinks.push({
			target,
			subpath: subpathVal
				? {
						kind: isBlock ? "block" : "heading",
						value: subpathVal,
					}
				: undefined,
			alias: alias && alias.length > 0 ? alias : undefined,
			range: {
				startOffset: matchStart,
				endOffset: matchEnd,
			},
		});
	}

	// 7. Extract Body Tags: #tag, #nested/tag
	// Exclude pure numbers (#123) and tags inside frontmatter/code/math/headings
	const tagRegex =
		/(?:^|[\s(])#([a-zA-Z0-9_\-\/]*[a-zA-Z_\-\/][a-zA-Z0-9_\-\/]*)(?=$|[\s),.;:!?])/g;
	let tagMatch: RegExpExecArray | null;
	while ((tagMatch = tagRegex.exec(markdown)) !== null) {
		const fullMatch = tagMatch[0];
		const hashPos = fullMatch.indexOf("#");
		const startOffset = tagMatch.index + hashPos;
		const name = tagMatch[1];
		if (!name) continue;
		const endOffset = startOffset + 1 + name.length;

		if (isOverlapping(startOffset, endOffset, codeAndMathRanges)) {
			continue;
		}

		// Also check that it's not a heading marker line like `# Heading`
		const lineStart = markdown.lastIndexOf("\n", startOffset) + 1;
		const linePrefix = markdown.slice(lineStart, startOffset);
		if (/^#{1,6}\s*$/.test(linePrefix)) {
			continue;
		}

		tags.push({
			name,
			source: "body",
			range: {
				startOffset,
				endOffset,
			},
		});
	}

	// 8. Build Hierarchical Sections with nested blocks
	const sections: ParsedSection[] = [];
	const hierarchyStack: Array<{ level: number; text: string }> = [];

	if (headings.length === 0) {
		// Document without headings has a single root section if blocks exist
		if (blocks.length > 0) {
			const startOffset = blocks[0]!.range.startOffset;
			const endOffset = markdown.length;
			sections.push({
				id: "root",
				heading: undefined,
				headingHierarchy: [],
				range: { startOffset, endOffset },
				rawText: markdown.slice(startOffset, endOffset),
				blocks: [...blocks],
			});
		}
	} else {
		// Check for preamble content before first heading
		const firstHeading = headings[0]!;
		const preambleBlocks = blocks.filter(
			(b) => b.range.endOffset <= firstHeading.range.startOffset,
		);
		if (preambleBlocks.length > 0) {
			const startOffset = preambleBlocks[0]!.range.startOffset;
			const endOffset = firstHeading.range.startOffset;
			sections.push({
				id: "preamble",
				heading: undefined,
				headingHierarchy: [],
				range: { startOffset, endOffset },
				rawText: markdown.slice(startOffset, endOffset),
				blocks: preambleBlocks,
			});
		}

		// Process each heading into a section
		for (let i = 0; i < headings.length; i++) {
			const heading = headings[i]!;

			// Maintain heading hierarchy stack
			while (
				hierarchyStack.length > 0 &&
				hierarchyStack[hierarchyStack.length - 1]!.level >= heading.level
			) {
				hierarchyStack.pop();
			}
			hierarchyStack.push({ level: heading.level, text: heading.text });
			const headingHierarchy = hierarchyStack.map((h) => h.text);

			// Find boundary: next heading with level <= current heading level
			let nextBoundaryOffset = markdown.length;
			for (let j = i + 1; j < headings.length; j++) {
				const nextHeading = headings[j]!;
				if (nextHeading.level <= heading.level) {
					nextBoundaryOffset = nextHeading.range.startOffset;
					break;
				}
			}

			const sectionRange: TextRange = {
				startOffset: heading.range.startOffset,
				endOffset: nextBoundaryOffset,
			};

			const sectionBlocks = blocks.filter(
				(b) =>
					b.range.startOffset >= sectionRange.startOffset &&
					b.range.endOffset <= sectionRange.endOffset,
			);

			const section: ParsedSection = {
				id: heading.slug || `section-${i + 1}`,
				heading,
				headingHierarchy,
				range: sectionRange,
				rawText: markdown.slice(sectionRange.startOffset, sectionRange.endOffset),
				blocks: sectionBlocks,
			};

			sections.push(section);
		}
	}

	const result: ParsedObsidianDocument = {
		filePath,
		frontmatter,
		frontmatterRange,
		headings,
		sections,
		blocks,
		wikiLinks,
		tags,
		callouts,
		equations,
		tables,
	};

	const validated = validateParsedObsidianDocument(result);

	// Non-enumerable convenience aliases for downstream compatibility
	Object.defineProperty(validated, "wikilinks", {
		get: () => validated.wikiLinks,
		enumerable: false,
	});
	Object.defineProperty(validated, "blockIds", {
		get: () => {
			const map: Record<string, TextRange> = {};
			for (const b of validated.blocks) {
				if (b.id) map[b.id] = b.range;
			}
			return map;
		},
		enumerable: false,
	});

	for (const sec of validated.sections) {
		Object.defineProperty(sec, "level", {
			get: () => sec.heading?.level ?? 0,
			enumerable: false,
		});
		Object.defineProperty(sec, "blockIds", {
			get: () =>
				sec.blocks.map((b) => b.id).filter((id): id is string => Boolean(id)),
			enumerable: false,
		});
	}

	return validated;
}
