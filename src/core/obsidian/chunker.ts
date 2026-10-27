/**
 * Pure Obsidian Markdown Section-Aware Chunker.
 *
 * Implements deterministic, section-aware chunking for Obsidian Markdown documents:
 * - Preserves hierarchical heading paths (e.g. ["# Heading 1", "## Heading 2"])
 * - Preserves code blocks, tables, LaTeX blocks, and callouts intact within single chunks
 * - Bounded by token budget (maxTokens) with paragraph/line splitting when blocks exceed budget
 * - Computes byte-exact character offsets: rawContent.slice(startOffset, endOffset) === chunk.content
 * - Zero Node.js runtime or DOM dependencies (pure TypeScript, browser-safe)
 */

import {
	type ParsedBlock,
	type ParsedObsidianDocument,
	type ParsedSection,
	type TextRange,
} from "../contracts/obsidian.ts";
import {
	type ChunkerOptions,
	type MarkdownChunk,
	validateMarkdownChunk,
} from "../contracts/chunker.ts";

/**
 * Fast, conservative token estimator (~4 chars per token).
 */
export function estimateMarkdownTokens(content: string): number {
	if (!content || content.length === 0) return 0;
	return Math.ceil(content.length / 4);
}

export const estimateTokens = estimateMarkdownTokens;

/**
 * Pure TypeScript 64-bit FNV-1a hash producing a 16-character hexadecimal string.
 * Zero Node.js or DOM runtime dependencies (browser-safe, worker-safe).
 */
export function deterministicHash(input: string): string {
	let hash = 0xcbf29ce484222325n;
	const prime = 0x100000001b3n;
	for (let i = 0; i < input.length; i++) {
		hash ^= BigInt(input.charCodeAt(i));
		hash = (hash * prime) & 0xffffffffffffffffn;
	}
	return hash.toString(16).padStart(16, "0");
}

/**
 * Splits a single large block that exceeds maxTokens into smaller slices
 * along natural boundaries (paragraphs, lines, sentences, or whitespace).
 */
function splitLargeBlock(
	block: ParsedBlock,
	rawContent: string,
	maxTokens: number,
): Array<{ range: TextRange; content: string }> {
	const blockStart = block.range.startOffset;
	const blockEnd = block.range.endOffset;
	const blockText = rawContent.slice(blockStart, blockEnd);

	if (estimateTokens(blockText) <= maxTokens) {
		return [{ range: { startOffset: blockStart, endOffset: blockEnd }, content: blockText }];
	}

	const maxChars = Math.max(4, maxTokens * 4);
	const slices: Array<{ range: TextRange; content: string }> = [];
	let pos = 0;

	while (pos < blockText.length) {
		const remaining = blockText.length - pos;
		if (estimateTokens(blockText.slice(pos)) <= maxTokens) {
			slices.push({
				range: { startOffset: blockStart + pos, endOffset: blockEnd },
				content: rawContent.slice(blockStart + pos, blockEnd),
			});
			break;
		}

		const searchLimit = Math.min(pos + maxChars, blockText.length);
		const sub = blockText.slice(pos, searchLimit);
		let splitRel = -1;

		// 1. Try paragraph break \r?\n\r?\n
		const dnlMatches = [...sub.matchAll(/\r?\n[ \t]*\r?\n/g)];
		if (dnlMatches.length > 0) {
			const lastMatch = dnlMatches[dnlMatches.length - 1]!;
			if (lastMatch.index !== undefined && lastMatch.index > 0) {
				splitRel = lastMatch.index + lastMatch[0].length;
			}
		}

		// 2. Try newline \n
		if (splitRel <= 0) {
			const nl = sub.lastIndexOf("\n");
			if (nl > 0) {
				splitRel = nl + 1;
			}
		}

		// 3. Try sentence end (. ! ? followed by space or newline)
		if (splitRel <= 0 && (block.kind === "paragraph" || block.kind === "list")) {
			const sentMatches = [...sub.matchAll(/[.!?][ \t\r\n]+/g)];
			if (sentMatches.length > 0) {
				const lastSent = sentMatches[sentMatches.length - 1]!;
				if (lastSent.index !== undefined && lastSent.index > 0) {
					splitRel = lastSent.index + lastSent[0].length;
				}
			}
		}

		// 4. Try whitespace
		if (splitRel <= 0) {
			const sp = sub.lastIndexOf(" ");
			if (sp > 0) {
				splitRel = sp + 1;
			}
		}

		// Fallback: split at character boundary
		if (splitRel <= 0 || splitRel >= remaining) {
			splitRel = Math.min(maxChars, remaining);
		}

		// Avoid splitting CRLF (\r\n)
		if (splitRel > 0 && splitRel < remaining) {
			if (
				blockText.charCodeAt(pos + splitRel - 1) === 0x0d &&
				blockText.charCodeAt(pos + splitRel) === 0x0a
			) {
				splitRel += 1;
			}
		}

		// Avoid splitting UTF-16 surrogate pairs (e.g. emojis)
		if (splitRel > 0 && splitRel < remaining) {
			const prevCode = blockText.charCodeAt(pos + splitRel - 1);
			if (prevCode >= 0xd800 && prevCode <= 0xdbff) {
				if (
					pos + splitRel < blockText.length &&
					estimateTokens(blockText.slice(pos, pos + splitRel + 1)) <= maxTokens
				) {
					splitRel += 1;
				} else if (splitRel > 1) {
					splitRel -= 1;
				} else {
					splitRel += 1;
				}
			}
		}

		if (splitRel <= 0) {
			splitRel = Math.min(maxChars, remaining);
		}

		const chunkStart = blockStart + pos;
		const chunkEnd = blockStart + pos + splitRel;
		slices.push({
			range: { startOffset: chunkStart, endOffset: chunkEnd },
			content: rawContent.slice(chunkStart, chunkEnd),
		});
		pos += splitRel;
	}

	return slices;
}

/**
 * Creates a validated MarkdownChunk instance with full metadata and flags.
 */
function createChunk(
	documentPath: string,
	section: ParsedSection,
	range: TextRange,
	content: string,
	blocks: ParsedBlock[],
	doc: ParsedObsidianDocument,
): MarkdownChunk {
	const tokenEstimate = estimateTokens(content);
	const hash = deterministicHash(
		`${documentPath}:${range.startOffset}:${range.endOffset}:${content}`,
	);
	const id = `chk_${hash.slice(0, 16)}`;

	// Extract block references (^block-id)
	const blockIdSet = new Set<string>();
	for (const b of blocks) {
		if (b.id) blockIdSet.add(b.id);
	}
	for (const b of doc.blocks) {
		if (
			b.id &&
			b.range.startOffset >= range.startOffset &&
			b.range.endOffset <= range.endOffset
		) {
			blockIdSet.add(b.id);
		}
	}
	const blockRefRegex = /(?:^|\s)\^([a-zA-Z0-9_-]+)(?=$|\s)/g;
	let match: RegExpExecArray | null;
	while ((match = blockRefRegex.exec(content)) !== null) {
		if (match[1]) blockIdSet.add(match[1]);
	}
	const blockIds = blockIdSet.size > 0 ? Array.from(blockIdSet) : undefined;

	// Check syntax capability flags
	const hasCodeBlock =
		blocks.some((b) => b.kind === "code") ||
		doc.blocks.some(
			(b) =>
				b.kind === "code" &&
				b.range.startOffset >= range.startOffset &&
				b.range.endOffset <= range.endOffset,
		) ||
		content.includes("```");

	const hasTable =
		blocks.some((b) => b.kind === "table") ||
		doc.blocks.some(
			(b) =>
				b.kind === "table" &&
				b.range.startOffset >= range.startOffset &&
				b.range.endOffset <= range.endOffset,
		) ||
		(doc.tables?.some(
			(t) =>
				t.range.startOffset >= range.startOffset &&
				t.range.endOffset <= range.endOffset,
		) ?? false);

	const hasEquation =
		blocks.some((b) => b.kind === "math") ||
		doc.blocks.some(
			(b) =>
				b.kind === "math" &&
				b.range.startOffset >= range.startOffset &&
				b.range.endOffset <= range.endOffset,
		) ||
		(doc.equations?.some(
			(eq) =>
				eq.range.startOffset >= range.startOffset &&
				eq.range.endOffset <= range.endOffset,
		) ?? false) ||
		content.includes("$$");

	const heading =
		section.heading?.text ??
		(typeof (section as unknown as { heading?: unknown }).heading === "string"
			? (section as unknown as { heading?: string }).heading
			: undefined);

	const chunk: MarkdownChunk = {
		id,
		documentPath,
		headingHierarchy: [...section.headingHierarchy],
		heading: heading && heading.length > 0 ? heading : undefined,
		range,
		content,
		tokenEstimate,
		blockIds,
		hasCodeBlock: hasCodeBlock ? true : undefined,
		hasTable: hasTable ? true : undefined,
		hasEquation: hasEquation ? true : undefined,
	};

	return validateMarkdownChunk(chunk);
}

/**
 * Pure domain chunker for parsed Obsidian Markdown documents.
 *
 * Partitions documents into section-aligned Markdown chunks respecting token budgets,
 * preserving code blocks, tables, LaTeX blocks, callouts, and hierarchical headings.
 */
export function chunkObsidianDocument(
	doc: ParsedObsidianDocument,
	rawContent: string,
	options?: ChunkerOptions,
): MarkdownChunk[] {
	if (
		!rawContent ||
		rawContent.trim().length === 0 ||
		!doc.sections ||
		doc.sections.length === 0
	) {
		return [];
	}

	const maxTokens = options?.maxTokens ?? 500;
	const documentPath = options?.documentPath ?? doc.filePath ?? "";
	const chunks: MarkdownChunk[] = [];

	for (const section of doc.sections) {
		const sectionBlocks: ParsedBlock[] = [];

		// If section has a heading, ensure heading block is present
		if (section.heading) {
			const hasHeadingBlock = section.blocks.some(
				(b) =>
					b.kind === "heading" &&
					b.range.startOffset === section.heading!.range.startOffset,
			);
			if (!hasHeadingBlock) {
				sectionBlocks.push({
					kind: "heading",
					range: section.heading.range,
					rawText: rawContent.slice(
						section.heading.range.startOffset,
						section.heading.range.endOffset,
					),
				});
			}
		}

		for (const b of section.blocks) {
			if (
				section.heading &&
				b.kind === "heading" &&
				b.range.startOffset === section.heading.range.startOffset &&
				sectionBlocks.length > 0
			) {
				continue;
			}
			sectionBlocks.push(b);
		}

		// Fallback if section has no blocks but non-empty range
		if (sectionBlocks.length === 0) {
			if (section.range.endOffset > section.range.startOffset) {
				const text = rawContent.slice(
					section.range.startOffset,
					section.range.endOffset,
				);
				if (text.trim().length > 0) {
					sectionBlocks.push({
						kind: "paragraph",
						range: section.range,
						rawText: text,
					});
				}
			}
		}

		if (sectionBlocks.length === 0) {
			continue;
		}

		let currentBlocks: ParsedBlock[] = [];

		const flushCurrent = () => {
			if (currentBlocks.length === 0) return;
			const startOffset = currentBlocks[0]!.range.startOffset;
			const endOffset = currentBlocks[currentBlocks.length - 1]!.range.endOffset;
			const content = rawContent.slice(startOffset, endOffset);
			chunks.push(
				createChunk(
					documentPath,
					section,
					{ startOffset, endOffset },
					content,
					currentBlocks,
					doc,
				),
			);
			currentBlocks = [];
		};

		for (let i = 0; i < sectionBlocks.length; i++) {
			const block = sectionBlocks[i]!;
			const blockText = rawContent.slice(block.range.startOffset, block.range.endOffset);
			const blockTokens = estimateTokens(blockText);

			if (blockTokens > maxTokens) {
				// Flush accumulated blocks before large block
				flushCurrent();

				// Split large block
				const slices = splitLargeBlock(block, rawContent, maxTokens);
				for (const slice of slices) {
					chunks.push(
						createChunk(
							documentPath,
							section,
							slice.range,
							slice.content,
							[block],
							doc,
						),
					);
				}
				continue;
			}

			if (currentBlocks.length === 0) {
				currentBlocks.push(block);
			} else {
				const candidateStart = currentBlocks[0]!.range.startOffset;
				const candidateEnd = block.range.endOffset;
				const candidateContent = rawContent.slice(candidateStart, candidateEnd);
				const candidateTokens = estimateTokens(candidateContent);

				if (candidateTokens <= maxTokens) {
					currentBlocks.push(block);
				} else {
					flushCurrent();
					currentBlocks.push(block);
				}
			}
		}

		flushCurrent();
	}

	return chunks;
}
