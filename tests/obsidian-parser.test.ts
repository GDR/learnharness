/**
 * Comprehensive Unit and Integration Tests for Obsidian Markdown AST & Feature Parser.
 *
 * Verifies Milestone B Slice 3:
 * - YAML frontmatter extraction, metadata parsing, and character offsets
 * - Headings (depths 1–6), slug generation, and ancestor heading hierarchy
 * - Hierarchical sections with nested blocks and preamble handling
 * - Tables (GFM syntax) with headers and rows
 * - Fenced code blocks with language annotations
 * - LaTeX math: inline ($...$) and block ($$...$$)
 * - Wiki-links with targets, subpaths (#heading, #^block-id), and aliases
 * - Block references (^block-id) attached to blocks and sections
 * - Tags (frontmatter tags, body tags, nested tags, excluding numeric & code/math)
 * - Callouts with types, fold markers (+/-), titles, and nested callouts
 * - Fixture validation against Physics/Quantum/Schrodinger.md, Newton.md, etc.
 * - Edge cases: empty strings, whitespace, no frontmatter, frontmatter only,
 *   malformed YAML, CRLF vs LF offsets, and Unicode characters.
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
	parseObsidianMarkdown,
	slugifyHeading,
	validateParsedObsidianDocument,
} from "../src/core/index.ts";

const FIXTURES_DIR = path.join(process.cwd(), "tests/fixtures/obsidian-vault");

describe("Milestone B Slice 3: Obsidian Markdown AST & Feature Parser", () => {
	// ─── 1. Fixture Tests: Schrodinger.md ──────────────────────────────────────

	describe("Fixture: Physics/Quantum/Schrodinger.md", () => {
		const filePath = path.join(FIXTURES_DIR, "Physics/Quantum/Schrodinger.md");
		const content = fs.readFileSync(filePath, "utf-8");
		const parsed = parseObsidianMarkdown(content, "Physics/Quantum/Schrodinger.md");

		it("validates against ParsedObsidianDocument schema", () => {
			assert.doesNotThrow(() => validateParsedObsidianDocument(parsed));
			assert.equal(parsed.filePath, "Physics/Quantum/Schrodinger.md");
		});

		it("extracts YAML frontmatter metadata and exact offsets", () => {
			assert.ok(parsed.frontmatterRange, "Must have frontmatterRange");
			assert.equal(parsed.frontmatterRange.startOffset, 0);
			assert.ok(parsed.frontmatterRange.endOffset > 0);

			// Verify slice matches frontmatter boundary
			const fmSlice = content.slice(
				parsed.frontmatterRange.startOffset,
				parsed.frontmatterRange.endOffset,
			);
			assert.ok(fmSlice.startsWith("---"));
			assert.ok(fmSlice.trimEnd().endsWith("---"));

			// Check metadata fields
			assert.equal(parsed.frontmatter.title, "Erwin Schrödinger and Wave Mechanics");
			assert.equal(parsed.frontmatter.author, "Erwin Schrödinger");
			assert.equal(parsed.frontmatter.difficulty, "intermediate");
			assert.deepEqual(parsed.frontmatter.aliases, [
				"Schrödinger Equation",
				"Wave Equation",
			]);
		});

		it("extracts frontmatter tags with frontmatter source", () => {
			const fmTags = parsed.tags.filter((t) => t.source === "frontmatter");
			assert.ok(fmTags.length >= 3);
			const tagNames = fmTags.map((t) => t.name);
			assert.ok(tagNames.includes("physics"));
			assert.ok(tagNames.includes("quantum"));
			assert.ok(tagNames.includes("wave-mechanics"));
		});

		it("extracts headings, slugs, and hierarchical ancestor paths", () => {
			assert.equal(parsed.headings.length, 3);

			const h1 = parsed.headings[0]!;
			assert.equal(h1.level, 1);
			assert.equal(h1.text, "Erwin Schrödinger and Wave Mechanics");
			assert.equal(h1.slug, "erwin-schrödinger-and-wave-mechanics");

			const h2a = parsed.headings[1]!;
			assert.equal(h2a.level, 2);
			assert.equal(h2a.text, "The Time-Dependent Schrödinger Equation");
			assert.equal(h2a.slug, "the-time-dependent-schrödinger-equation");

			const h2b = parsed.headings[2]!;
			assert.equal(h2b.level, 2);
			assert.equal(h2b.text, "Probabilistic Interpretation and Normalization");

			// Verify character offsets in raw content
			for (const h of parsed.headings) {
				const slice = content.slice(h.range.startOffset, h.range.endOffset);
				assert.ok(slice.includes(h.text), `Slice must contain heading text: ${h.text}`);
			}
		});

		it("segments document into structural sections with nested blocks", () => {
			assert.equal(parsed.sections.length, 3);

			// Section 1: H1
			const sec1 = parsed.sections[0]!;
			assert.equal(sec1.heading?.level, 1);
			assert.deepEqual(sec1.headingHierarchy, ["Erwin Schrödinger and Wave Mechanics"]);

			// Section 2: H2 (The Time-Dependent Schrödinger Equation)
			const sec2 = parsed.sections[1]!;
			assert.equal(sec2.heading?.level, 2);
			assert.deepEqual(sec2.headingHierarchy, [
				"Erwin Schrödinger and Wave Mechanics",
				"The Time-Dependent Schrödinger Equation",
			]);
			// Section 2 contains math block with ^eq1
			const eqBlock = sec2.blocks.find((b) => b.id === "eq1");
			assert.ok(eqBlock, "Section 2 must contain block with id eq1");
			assert.equal(eqBlock.kind, "math");

			// Section 3: H2 (Probabilistic Interpretation and Normalization)
			const sec3 = parsed.sections[2]!;
			assert.equal(sec3.heading?.level, 2);
			assert.deepEqual(sec3.headingHierarchy, [
				"Erwin Schrödinger and Wave Mechanics",
				"Probabilistic Interpretation and Normalization",
			]);
		});

		it("extracts block references and maps them to block spans", () => {
			const block = parsed.blocks.find((b) => b.id === "eq1");
			assert.ok(block, "Must extract block with id eq1");
			assert.ok(block.range.startOffset > 0);
			assert.ok(block.range.endOffset > block.range.startOffset);

			const slice = content.slice(block.range.startOffset, block.range.endOffset);
			assert.ok(slice.includes("^eq1"), "Offset range slice must include ^eq1");

			// Check blockIds convenience getter
			const blockIds = (parsed as unknown as { blockIds: Record<string, unknown> }).blockIds;
			assert.ok("eq1" in blockIds, "parsed.blockIds must include eq1");
		});

		it("extracts callout with type, title, and range", () => {
			assert.equal(parsed.callouts.length, 1);
			const callout = parsed.callouts[0]!;
			assert.equal(callout.type, "note");
			assert.equal(callout.title, "Fundamental Postulate");

			const slice = content.slice(callout.range.startOffset, callout.range.endOffset);
			assert.ok(slice.includes("> [!note] Fundamental Postulate"));
			assert.ok(slice.includes("The state of a quantum physical system"));
		});

		it("extracts wikilinks with targets, aliases, and character offsets", () => {
			assert.equal(parsed.wikiLinks.length, 3);

			const waveMech = parsed.wikiLinks.find((w) => w.target === "Wave Mechanics");
			assert.ok(waveMech);
			assert.equal(waveMech.alias, "wave mechanics");
			assert.equal(
				content.slice(waveMech.range.startOffset, waveMech.range.endOffset),
				"[[Wave Mechanics|wave mechanics]]",
			);

			const stateSpace = parsed.wikiLinks.find((w) => w.target === "LinearAlgebra");
			assert.ok(stateSpace);
			assert.equal(stateSpace.alias, "state space");

			const newton = parsed.wikiLinks.find(
				(w) => w.target === "Physics/Classical/Newton",
			);
			assert.ok(newton);
			assert.equal(newton.alias, "Newtonian mechanics");
		});

		it("extracts inline and block LaTeX equations", () => {
			assert.ok(parsed.equations, "equations must be defined");
			const blocks = parsed.equations.filter((e) => e.type === "block");
			const inlines = parsed.equations.filter((e) => e.type === "inline");

			assert.ok(blocks.length >= 2, "Must extract at least 2 block equations");
			assert.ok(inlines.length >= 4, "Must extract at least 4 inline equations");

			assert.ok(blocks.some((b) => b.content.includes("\\nabla^2")));
			assert.ok(inlines.some((i) => i.content.includes("\\Psi(\\mathbf{r}, t)")));
		});
	});

	// ─── 2. Fixture Tests: Newton.md & LinearAlgebra.md ─────────────────────────

	describe("Fixture: Physics/Classical/Newton.md", () => {
		const filePath = path.join(FIXTURES_DIR, "Physics/Classical/Newton.md");
		const content = fs.readFileSync(filePath, "utf-8");
		const parsed = parseObsidianMarkdown(content);

		it("extracts structured GFM table with header and rows", () => {
			assert.ok(parsed.tables, "tables must be defined");
			assert.equal(parsed.tables.length, 1);

			const table = parsed.tables[0]!;
			assert.deepEqual(table.header, [
				"Law",
				"Principle",
				"Mathematical Formulation",
				"Physical Interpretation",
			]);
			assert.equal(table.rows.length, 3);
			assert.equal(table.rows[0]?.[0], "First Law");
			assert.equal(table.rows[1]?.[0], "Second Law");
			assert.equal(table.rows[2]?.[0], "Third Law");

			const slice = content.slice(table.range.startOffset, table.range.endOffset);
			assert.ok(slice.includes("| Law | Principle |"));
		});

		it("identifies table as a parsed block of kind table", () => {
			const tableBlock = parsed.blocks.find((b) => b.kind === "table");
			assert.ok(tableBlock, "Must find block with kind table");
			assert.ok(tableBlock.rawText.includes("| First Law |"));
		});
	});

	describe("Fixture: Math/LinearAlgebra.md", () => {
		const filePath = path.join(FIXTURES_DIR, "Math/LinearAlgebra.md");
		const content = fs.readFileSync(filePath, "utf-8");
		const parsed = parseObsidianMarkdown(content);

		it("extracts block reference on spectral equation", () => {
			const eigenBlock = parsed.blocks.find((b) => b.id === "matrix-eigen");
			assert.ok(eigenBlock, "Must find block with id matrix-eigen");
			assert.equal(eigenBlock.kind, "math");
			assert.ok(eigenBlock.rawText.includes("^matrix-eigen"));
		});

		it("extracts multiple sections and verifies ancestor hierarchy", () => {
			assert.ok(parsed.sections.length >= 3);
			const h1 = parsed.sections[0]!;
			assert.equal(h1.heading?.text, "Linear Algebra");

			const eigenSec = parsed.sections.find(
				(s) => s.heading?.text === "Eigenvalues and Eigenvectors",
			);
			assert.ok(eigenSec);
			assert.deepEqual(eigenSec.headingHierarchy, [
				"Linear Algebra",
				"Eigenvalues and Eigenvectors",
			]);
		});
	});

	// ─── 3. Wiki-Links Syntax & Subpaths ────────────────────────────────────────

	describe("Wiki-link Parsing & Subpaths", () => {
		it("extracts simple link [[target]]", () => {
			const text = "A link to [[Quantum State]] in prose.";
			const parsed = parseObsidianMarkdown(text);
			assert.equal(parsed.wikiLinks.length, 1);
			const link = parsed.wikiLinks[0]!;
			assert.equal(link.target, "Quantum State");
			assert.equal(link.alias, undefined);
			assert.equal(link.subpath, undefined);
			assert.equal(text.slice(link.range.startOffset, link.range.endOffset), "[[Quantum State]]");
		});

		it("extracts link with alias [[target|alias]]", () => {
			const text = "See [[Quantum State|state vector]] for details.";
			const parsed = parseObsidianMarkdown(text);
			assert.equal(parsed.wikiLinks.length, 1);
			const link = parsed.wikiLinks[0]!;
			assert.equal(link.target, "Quantum State");
			assert.equal(link.alias, "state vector");
			assert.equal(link.subpath, undefined);
		});

		it("extracts link with heading subpath [[target#heading]] and alias", () => {
			const text = "Check [[Calculus#Derivatives|differentiation]] rule.";
			const parsed = parseObsidianMarkdown(text);
			assert.equal(parsed.wikiLinks.length, 1);
			const link = parsed.wikiLinks[0]!;
			assert.equal(link.target, "Calculus");
			assert.deepEqual(link.subpath, { kind: "heading", value: "Derivatives" });
			assert.equal(link.alias, "differentiation");
		});

		it("extracts link with block subpath [[target#^block-id]]", () => {
			const text = "Reference to [[Notes#^eq-fundamental]].";
			const parsed = parseObsidianMarkdown(text);
			assert.equal(parsed.wikiLinks.length, 1);
			const link = parsed.wikiLinks[0]!;
			assert.equal(link.target, "Notes");
			assert.deepEqual(link.subpath, { kind: "block", value: "eq-fundamental" });
			assert.equal(link.alias, undefined);
		});

		it("extracts same-note heading link [[#Local Heading]]", () => {
			const text = "Jump to [[#Local Heading|summary]].";
			const parsed = parseObsidianMarkdown(text);
			assert.equal(parsed.wikiLinks.length, 1);
			const link = parsed.wikiLinks[0]!;
			assert.equal(link.target, "");
			assert.deepEqual(link.subpath, { kind: "heading", value: "Local Heading" });
			assert.equal(link.alias, "summary");
		});

		it("ignores wikilinks inside code blocks and inline code", () => {
			const text = [
				"Real link: [[Real Target]]",
				"Inline code: `[[Not A Link]]`",
				"```ts",
				"const foo = '[[Not A Link In Fenced Code]]';",
				"```",
			].join("\n");

			const parsed = parseObsidianMarkdown(text);
			assert.equal(parsed.wikiLinks.length, 1);
			assert.equal(parsed.wikiLinks[0]?.target, "Real Target");
		});

		it("ignores wikilinks inside math environments", () => {
			const text = [
				"Real link: [[Target]]",
				"Inline math: $[[not link]]$",
				"$$",
				"[[not link 2]]",
				"$$",
			].join("\n");
			const parsed = parseObsidianMarkdown(text);
			assert.equal(parsed.wikiLinks.length, 1);
			assert.equal(parsed.wikiLinks[0]?.target, "Target");
		});
	});

	// ─── 4. Tags Extraction ────────────────────────────────────────────────────

	describe("Tags Extraction & Filtration", () => {
		it("extracts simple tags, nested tags, and hyphenated tags", () => {
			const text = "This is #physics and #quantum/wave-mechanics plus #theory_1!";
			const parsed = parseObsidianMarkdown(text);
			const bodyTags = parsed.tags.filter((t) => t.source === "body");
			assert.equal(bodyTags.length, 3);
			assert.equal(bodyTags[0]?.name, "physics");
			assert.equal(bodyTags[1]?.name, "quantum/wave-mechanics");
			assert.equal(bodyTags[2]?.name, "theory_1");

			for (const t of bodyTags) {
				assert.ok(t.range);
				const slice = text.slice(t.range.startOffset, t.range.endOffset);
				assert.equal(slice, `#${t.name}`);
			}
		});

		it("skips purely numeric tags like #1999 or #123", () => {
			const text = "Event happened in #1999 or #2026, but see #y2026 or #tag123.";
			const parsed = parseObsidianMarkdown(text);
			const names = parsed.tags.map((t) => t.name);
			assert.ok(!names.includes("1999"), "Must skip numeric #1999");
			assert.ok(!names.includes("2026"), "Must skip numeric #2026");
			assert.ok(names.includes("y2026"), "Must include alphanumeric #y2026");
			assert.ok(names.includes("tag123"), "Must include alphanumeric #tag123");
		});

		it("skips tags inside code blocks and inline code", () => {
			const text = [
				"Real tag: #validTag",
				"Inline code: `#fakeTag`",
				"```ts",
				"#anotherFake",
				"```",
			].join("\n");
			const parsed = parseObsidianMarkdown(text);
			const names = parsed.tags.map((t) => t.name);
			assert.deepEqual(names, ["validTag"]);
		});

		it("does not treat markdown headings as tags", () => {
			const text = "# Heading One\n\nSome text #withTag\n\n## Heading Two";
			const parsed = parseObsidianMarkdown(text);
			const bodyTags = parsed.tags.filter((t) => t.source === "body");
			assert.equal(bodyTags.length, 1);
			assert.equal(bodyTags[0]?.name, "withTag");
		});

		it("normalizes comma-separated string frontmatter tags", () => {
			const text = "---\ntags: science, physics, advanced\n---\n# Note";
			const parsed = parseObsidianMarkdown(text);
			const fmTags = parsed.tags.filter((t) => t.source === "frontmatter");
			assert.deepEqual(
				fmTags.map((t) => t.name),
				["science", "physics", "advanced"],
			);
		});
	});

	// ─── 5. Callouts & Nested Callouts ─────────────────────────────────────────

	describe("Callouts & Fold Markers", () => {
		it("extracts basic callout with type and title", () => {
			const text = "> [!tip] Practical Advice\n> Always verify your offsets.";
			const parsed = parseObsidianMarkdown(text);
			assert.equal(parsed.callouts.length, 1);
			const c = parsed.callouts[0]!;
			assert.equal(c.type, "tip");
			assert.equal(c.title, "Practical Advice");
			assert.equal(c.fold, undefined);
		});

		it("extracts collapsible callout with + (expanded) and - (collapsed) fold markers", () => {
			const text = [
				"> [!warning]+ Expandable Warning",
				"> This is expanded by default.",
				"",
				"> [!danger]- Collapsed Danger",
				"> This is collapsed by default.",
			].join("\n");

			const parsed = parseObsidianMarkdown(text);
			assert.equal(parsed.callouts.length, 2);

			const c1 = parsed.callouts[0]!;
			assert.equal(c1.type, "warning");
			assert.equal(c1.fold, "+");
			assert.equal(c1.title, "Expandable Warning");

			const c2 = parsed.callouts[1]!;
			assert.equal(c2.type, "danger");
			assert.equal(c2.fold, "-");
			assert.equal(c2.title, "Collapsed Danger");
		});

		it("extracts callout without title", () => {
			const text = "> [!note]\n> Plain note without a title.";
			const parsed = parseObsidianMarkdown(text);
			assert.equal(parsed.callouts.length, 1);
			assert.equal(parsed.callouts[0]?.type, "note");
			assert.equal(parsed.callouts[0]?.title, undefined);
		});

		it("extracts nested callouts recursively", () => {
			const text = [
				"> [!note] Outer Callout",
				"> Outer content line.",
				">",
				"> > [!warning]+ Inner Callout",
				"> > Inner warning content.",
			].join("\n");

			const parsed = parseObsidianMarkdown(text);
			assert.equal(parsed.callouts.length, 2, "Must extract both outer and inner callouts");

			const outer = parsed.callouts.find((c) => c.title === "Outer Callout");
			const inner = parsed.callouts.find((c) => c.title === "Inner Callout");

			assert.ok(outer);
			assert.equal(outer.type, "note");
			assert.ok(inner);
			assert.equal(inner.type, "warning");
			assert.equal(inner.fold, "+");

			// Inner callout must be nested within outer callout offsets
			assert.ok(inner.range.startOffset > outer.range.startOffset);
			assert.ok(inner.range.endOffset <= outer.range.endOffset);
		});
	});

	// ─── 6. Headings, Sections & Preamble ──────────────────────────────────────

	describe("Headings & Structural Hierarchy", () => {
		it("generates clean URL slugs with slugifyHeading", () => {
			assert.equal(slugifyHeading("Theoretical Foundations"), "theoretical-foundations");
			assert.equal(
				slugifyHeading("Erwin Schrödinger & Wave Mechanics!"),
				"erwin-schrödinger-wave-mechanics",
			);
			assert.equal(slugifyHeading("   "), "heading");
		});

		it("tracks multi-level ancestor heading hierarchy", () => {
			const text = [
				"# Physics",
				"Intro physics.",
				"## Quantum Mechanics",
				"Quantum concepts.",
				"### Wave Mechanics",
				"Wave details.",
				"#### Wave Function",
				"Psi formula.",
				"## Classical Mechanics",
				"Newtonian.",
			].join("\n");

			const parsed = parseObsidianMarkdown(text);
			assert.equal(parsed.sections.length, 5);

			assert.deepEqual(parsed.sections[0]?.headingHierarchy, ["Physics"]);
			assert.deepEqual(parsed.sections[1]?.headingHierarchy, [
				"Physics",
				"Quantum Mechanics",
			]);
			assert.deepEqual(parsed.sections[2]?.headingHierarchy, [
				"Physics",
				"Quantum Mechanics",
				"Wave Mechanics",
			]);
			assert.deepEqual(parsed.sections[3]?.headingHierarchy, [
				"Physics",
				"Quantum Mechanics",
				"Wave Mechanics",
				"Wave Function",
			]);
			assert.deepEqual(parsed.sections[4]?.headingHierarchy, [
				"Physics",
				"Classical Mechanics",
			]);
		});

		it("creates a preamble section for content before the first heading", () => {
			const text = [
				"---",
				"title: My Doc",
				"---",
				"This is preamble text before any heading.",
				"",
				"# Chapter 1",
				"Chapter content.",
			].join("\n");

			const parsed = parseObsidianMarkdown(text);
			assert.equal(parsed.sections.length, 2);

			const preamble = parsed.sections[0]!;
			assert.equal(preamble.id, "preamble");
			assert.equal(preamble.heading, undefined);
			assert.deepEqual(preamble.headingHierarchy, []);
			assert.ok(preamble.rawText.includes("preamble text"));

			const ch1 = parsed.sections[1]!;
			assert.equal(ch1.heading?.text, "Chapter 1");
		});

		it("creates a single root section for documents without any headings", () => {
			const text = "A simple document with no headings.\nJust paragraphs and lists.";
			const parsed = parseObsidianMarkdown(text);
			assert.equal(parsed.headings.length, 0);
			assert.equal(parsed.sections.length, 1);

			const root = parsed.sections[0]!;
			assert.equal(root.id, "root");
			assert.equal(root.heading, undefined);
			assert.deepEqual(root.headingHierarchy, []);
			assert.equal(root.blocks.length, 1);
		});
	});

	// ─── 7. Fenced Code Blocks & Block References ──────────────────────────────

	describe("Fenced Code Blocks & Block References", () => {
		it("extracts fenced code blocks with language and offsets", () => {
			const text = [
				"# Code Example",
				"",
				"```typescript",
				"const greeting: string = 'Hello, world!';",
				"console.log(greeting);",
				"```",
			].join("\n");

			const parsed = parseObsidianMarkdown(text);
			const codeBlock = parsed.blocks.find((b) => b.kind === "code");
			assert.ok(codeBlock);
			assert.ok(codeBlock.rawText.includes("const greeting: string"));

			const slice = text.slice(codeBlock.range.startOffset, codeBlock.range.endOffset);
			assert.ok(slice.startsWith("```typescript"));
		});

		it("extracts block references attached to paragraphs", () => {
			const text = "A key assertion stated directly in prose. ^key-assertion\n\nNext paragraph.";
			const parsed = parseObsidianMarkdown(text);
			const p1 = parsed.blocks[0]!;
			assert.equal(p1.id, "key-assertion");
			assert.equal(p1.kind, "paragraph");

			const blockIds = (parsed as unknown as { blockIds: Record<string, unknown> }).blockIds;
			assert.ok("key-assertion" in blockIds);
		});

		it("extracts block references attached to callouts", () => {
			const text = "> [!tip] Important Note\n> Content here. ^callout-ref";
			const parsed = parseObsidianMarkdown(text);
			const calloutBlock = parsed.blocks.find((b) => b.kind === "callout");
			assert.ok(calloutBlock);
			assert.equal(calloutBlock.id, "callout-ref");
		});
	});

	// ─── 8. Robustness & Edge Cases ────────────────────────────────────────────

	describe("Robustness & Edge Cases", () => {
		it("handles empty strings cleanly", () => {
			const parsed = parseObsidianMarkdown("");
			assert.equal(parsed.headings.length, 0);
			assert.equal(parsed.sections.length, 0);
			assert.equal(parsed.blocks.length, 0);
			assert.equal(parsed.wikiLinks.length, 0);
			assert.equal(parsed.tags.length, 0);
			assert.equal(parsed.callouts.length, 0);
			assert.deepEqual(parsed.frontmatter, {});
			assert.equal(parsed.frontmatterRange, undefined);
		});

		it("handles whitespace-only documents", () => {
			const parsed = parseObsidianMarkdown("   \n\n\t  \n");
			assert.equal(parsed.headings.length, 0);
			assert.equal(parsed.sections.length, 0);
			assert.equal(parsed.blocks.length, 0);
		});

		it("handles frontmatter only without body", () => {
			const text = "---\ntitle: Standalone Frontmatter\nauthor: Scholar\n---\n";
			const parsed = parseObsidianMarkdown(text);
			assert.equal(parsed.frontmatter.title, "Standalone Frontmatter");
			assert.equal(parsed.frontmatter.author, "Scholar");
			assert.ok(parsed.frontmatterRange);
			assert.equal(parsed.headings.length, 0);
			assert.equal(parsed.sections.length, 0);
			assert.equal(parsed.blocks.length, 0);
		});

		it("recovers gracefully from malformed YAML frontmatter", () => {
			const text = [
				"---",
				"title: Good",
				"  bad indentation: [1, 2",
				"---",
				"# Title After Malformed YAML",
				"Paragraph content.",
			].join("\n");

			assert.doesNotThrow(() => {
				const parsed = parseObsidianMarkdown(text);
				assert.deepEqual(parsed.frontmatter, {});
				assert.ok(parsed.frontmatterRange);
				assert.equal(parsed.headings.length, 1);
				assert.equal(parsed.headings[0]?.text, "Title After Malformed YAML");
			});
		});

		it("preserves exact character offsets across Windows CRLF line endings", () => {
			const lfText = "# Heading\n\nParagraph with [[Link]] and $x = 1$.\n";
			const crlfText = "# Heading\r\n\r\nParagraph with [[Link]] and $x = 1$.\r\n";

			const parsedLf = parseObsidianMarkdown(lfText);
			const parsedCrlf = parseObsidianMarkdown(crlfText);

			assert.equal(parsedLf.wikiLinks.length, 1);
			assert.equal(parsedCrlf.wikiLinks.length, 1);

			const lfLink = parsedLf.wikiLinks[0]!;
			const crlfLink = parsedCrlf.wikiLinks[0]!;

			assert.equal(
				lfText.slice(lfLink.range.startOffset, lfLink.range.endOffset),
				"[[Link]]",
			);
			assert.equal(
				crlfText.slice(crlfLink.range.startOffset, crlfLink.range.endOffset),
				"[[Link]]",
			);
		});

		it("handles Unicode characters and special math symbols without offset drift", () => {
			const text = [
				"# 物理学 (Physics) & Quantenmechanik",
				"",
				"Schrödinger equation: $\\Psi(\\mathbf{r}, t)$ with [[Quantenmechanik|Волновая механика]].",
				"",
				"> [!info] 💡 Notice",
				"> Unicode characters: ä, ö, ü, ß, й, ⚛️.",
			].join("\n");

			const parsed = parseObsidianMarkdown(text);
			assert.equal(parsed.headings.length, 1);
			assert.equal(parsed.wikiLinks.length, 1);
			assert.equal(parsed.callouts.length, 1);

			const link = parsed.wikiLinks[0]!;
			assert.equal(link.target, "Quantenmechanik");
			assert.equal(link.alias, "Волновая механика");
			assert.equal(
				text.slice(link.range.startOffset, link.range.endOffset),
				"[[Quantenmechanik|Волновая механика]]",
			);
		});

		it("handles empty frontmatter fences with LF and CRLF", () => {
			// LF empty frontmatter fence
			const lfText = "---\n---\n# Title After Empty FM\nParagraph content.\n";
			const parsedLf = parseObsidianMarkdown(lfText);
			assert.doesNotThrow(() => validateParsedObsidianDocument(parsedLf));
			assert.deepEqual(parsedLf.frontmatter, {});
			assert.ok(parsedLf.frontmatterRange);
			assert.equal(parsedLf.frontmatterRange.startOffset, 0);
			assert.equal(parsedLf.frontmatterRange.endOffset, 8);
			assert.equal(lfText.slice(0, parsedLf.frontmatterRange.endOffset), "---\n---\n");
			assert.equal(parsedLf.headings.length, 1);
			assert.equal(parsedLf.headings[0]?.text, "Title After Empty FM");
			assert.equal(parsedLf.headings[0]?.range.startOffset, 8);

			// CRLF empty frontmatter fence
			const crlfText = "---\r\n---\r\n# Title After Empty FM CRLF\r\nParagraph content.\r\n";
			const parsedCrlf = parseObsidianMarkdown(crlfText);
			assert.doesNotThrow(() => validateParsedObsidianDocument(parsedCrlf));
			assert.deepEqual(parsedCrlf.frontmatter, {});
			assert.ok(parsedCrlf.frontmatterRange);
			assert.equal(parsedCrlf.frontmatterRange.startOffset, 0);
			assert.equal(parsedCrlf.frontmatterRange.endOffset, 10);
			assert.equal(crlfText.slice(0, parsedCrlf.frontmatterRange.endOffset), "---\r\n---\r\n");
			assert.equal(parsedCrlf.headings.length, 1);
			assert.equal(parsedCrlf.headings[0]?.text, "Title After Empty FM CRLF");
			assert.equal(parsedCrlf.headings[0]?.range.startOffset, 10);
		});

		it("handles frontmatter at EOF without trailing newline (LF and CRLF)", () => {
			// Content at EOF
			const lfEof = "---\ntitle: EOF Note\n---";
			const parsedLf = parseObsidianMarkdown(lfEof);
			assert.doesNotThrow(() => validateParsedObsidianDocument(parsedLf));
			assert.equal(parsedLf.frontmatter.title, "EOF Note");
			assert.ok(parsedLf.frontmatterRange);
			assert.equal(parsedLf.frontmatterRange.startOffset, 0);
			assert.equal(parsedLf.frontmatterRange.endOffset, lfEof.length);

			const crlfEof = "---\r\ntitle: EOF Note CRLF\r\n---";
			const parsedCrlf = parseObsidianMarkdown(crlfEof);
			assert.doesNotThrow(() => validateParsedObsidianDocument(parsedCrlf));
			assert.equal(parsedCrlf.frontmatter.title, "EOF Note CRLF");
			assert.ok(parsedCrlf.frontmatterRange);
			assert.equal(parsedCrlf.frontmatterRange.startOffset, 0);
			assert.equal(parsedCrlf.frontmatterRange.endOffset, crlfEof.length);

			// Empty fence at EOF without trailing newline
			const emptyLfEof = "---\n---";
			const parsedEmptyLf = parseObsidianMarkdown(emptyLfEof);
			assert.doesNotThrow(() => validateParsedObsidianDocument(parsedEmptyLf));
			assert.deepEqual(parsedEmptyLf.frontmatter, {});
			assert.ok(parsedEmptyLf.frontmatterRange);
			assert.equal(parsedEmptyLf.frontmatterRange.startOffset, 0);
			assert.equal(parsedEmptyLf.frontmatterRange.endOffset, emptyLfEof.length);
		});

		it("slugifies headings correctly across emojis, symbols, and leading/trailing hyphens", () => {
			// Emojis stripped with leading/trailing hyphen removal
			assert.equal(slugifyHeading("## 🚀 Mission to Mars 2026"), "mission-to-mars-2026");
			assert.equal(slugifyHeading("🚀 Mission to Mars 2026"), "mission-to-mars-2026");
			assert.equal(slugifyHeading("# 🚀 Galactic Exploration 🌌"), "galactic-exploration");

			// Symbol-only headings fall back to 'heading'
			assert.equal(slugifyHeading("### !!! ???"), "heading");
			assert.equal(slugifyHeading("???"), "heading");
			assert.equal(slugifyHeading("---"), "heading");
			assert.equal(slugifyHeading(""), "heading");
			assert.equal(slugifyHeading("   "), "heading");

			// Leading and trailing hyphens stripped
			assert.equal(slugifyHeading("--Special Section--"), "special-section");
			assert.equal(slugifyHeading("---Heading Test---"), "heading-test");

			// Punctuation and Unicode preservation
			assert.equal(slugifyHeading("E = mc² & Beyond!?"), "e-mc²-beyond");
			assert.equal(slugifyHeading("Квантовая механика и волновая функция!"), "квантовая-механика-и-волновая-функция");
		});
	});
});
