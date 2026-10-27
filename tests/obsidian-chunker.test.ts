/**
 * Comprehensive Unit and Integration Tests for Obsidian Section-Aware Chunker.
 *
 * Verifies Milestone C Slice 2 (F19):
 * - Basic document with 2 sections produces 2 chunks with respective headings
 * - Code block and table preservation without mid-table or mid-code splitting
 * - LaTeX math block preservation ($$...$$)
 * - Character offsets match: rawContent.slice(chunk.range.startOffset, chunk.range.endOffset) === chunk.content
 * - Token estimate accuracy and deterministic chunk IDs
 * - Documents with only frontmatter or empty content
 * - Boundary conditions: Unicode emojis, CRLF line endings, massive code blocks
 * - Real fixture vault notes (Schrodinger.md, Newton.md)
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
	chunkObsidianDocument,
	estimateMarkdownTokens,
	parseObsidianMarkdown,
	validateMarkdownChunk,
	validateChunkerOptions,
} from "../src/core/index.ts";

const FIXTURES_DIR = path.join(process.cwd(), "tests/fixtures/obsidian-vault");

describe("Milestone C Slice 2: Section-Aware Markdown Chunker", () => {
	// ─── 1. Basic Document & Hierarchy ──────────────────────────────────────────

	describe("Basic Document Chunking", () => {
		it("chunks a 2-section document into 2 chunks with respective headings", () => {
			const markdown = [
				"# Introduction",
				"This is the first section introducing quantum phenomena.",
				"",
				"# Theoretical Framework",
				"This is the second section covering foundational mechanics.",
			].join("\n");

			const parsed = parseObsidianMarkdown(markdown, "notes/physics.md");
			const chunks = chunkObsidianDocument(parsed, markdown, { maxTokens: 500 });

			assert.equal(chunks.length, 2);

			// Chunk 1
			const c1 = chunks[0]!;
			assert.equal(c1.heading, "Introduction");
			assert.deepEqual(c1.headingHierarchy, ["Introduction"]);
			assert.equal(c1.documentPath, "notes/physics.md");
			assert.ok(c1.content.includes("This is the first section"));
			assert.equal(
				markdown.slice(c1.range.startOffset, c1.range.endOffset),
				c1.content,
			);

			// Chunk 2
			const c2 = chunks[1]!;
			assert.equal(c2.heading, "Theoretical Framework");
			assert.deepEqual(c2.headingHierarchy, ["Theoretical Framework"]);
			assert.equal(c2.documentPath, "notes/physics.md");
			assert.ok(c2.content.includes("This is the second section"));
			assert.equal(
				markdown.slice(c2.range.startOffset, c2.range.endOffset),
				c2.content,
			);
		});

		it("handles small notes without headings as a single clean chunk", () => {
			const markdown = "A concise note without headings that discusses fundamental concepts.";
			const parsed = parseObsidianMarkdown(markdown, "quick-note.md");
			const chunks = chunkObsidianDocument(parsed, markdown, { maxTokens: 500 });

			assert.equal(chunks.length, 1);
			const chunk = chunks[0]!;
			assert.equal(chunk.heading, undefined);
			assert.deepEqual(chunk.headingHierarchy, []);
			assert.equal(chunk.content, markdown);
			assert.equal(chunk.range.startOffset, 0);
			assert.equal(chunk.range.endOffset, markdown.length);
		});

		it("preserves preamble content before the first heading", () => {
			const markdown = [
				"Preamble text before any section.",
				"",
				"# Main Section",
				"Main section body.",
			].join("\n");

			const parsed = parseObsidianMarkdown(markdown);
			const chunks = chunkObsidianDocument(parsed, markdown);

			assert.equal(chunks.length, 2);
			assert.equal(chunks[0]!.heading, undefined);
			assert.ok(chunks[0]!.content.includes("Preamble text"));
			assert.equal(chunks[1]!.heading, "Main Section");
			assert.ok(chunks[1]!.content.includes("Main section body"));
		});

		it("preserves deep ancestor heading hierarchy (H1..H3) with disjoint non-overlapping ranges", () => {
			const markdown = [
				"# Physics",
				"General physics overview.",
				"",
				"## Quantum Mechanics",
				"Quantum fundamentals.",
				"",
				"### Wave Mechanics",
				"De Broglie waves and Schrödinger equation.",
			].join("\n");

			const parsed = parseObsidianMarkdown(markdown);
			const chunks = chunkObsidianDocument(parsed, markdown);

			assert.equal(chunks.length, 3);
			assert.deepEqual(chunks[0]!.headingHierarchy, ["Physics"]);
			assert.deepEqual(chunks[1]!.headingHierarchy, ["Physics", "Quantum Mechanics"]);
			assert.deepEqual(chunks[2]!.headingHierarchy, [
				"Physics",
				"Quantum Mechanics",
				"Wave Mechanics",
			]);

			// Verify disjoint non-overlapping ranges across hierarchical chunks
			for (let i = 0; i < chunks.length - 1; i++) {
				assert.ok(
					chunks[i]!.range.endOffset <= chunks[i + 1]!.range.startOffset,
					`Chunk ${i} and ${i + 1} must have disjoint character ranges`,
				);
			}
			assert.ok(!chunks[0]!.content.includes("Quantum fundamentals"));
			assert.ok(!chunks[0]!.content.includes("De Broglie waves"));
			assert.ok(!chunks[1]!.content.includes("De Broglie waves"));
		});
	});

	// ─── 2. Structural Elements Preservation ────────────────────────────────────

	describe("Preservation of Code Blocks, Tables, and Math", () => {
		it("preserves code blocks and tables intact without mid-structure splitting", () => {
			const markdown = [
				"# Computing",
				"Here is an algorithm implementation:",
				"",
				"```python",
				"def quicksort(arr):",
				"    if len(arr) <= 1:",
				"        return arr",
				"    pivot = arr[len(arr) // 2]",
				"    left = [x for x in arr if x < pivot]",
				"    middle = [x for x in arr if x == pivot]",
				"    right = [x for x in arr if x > pivot]",
				"    return quicksort(left) + middle + quicksort(right)",
				"```",
				"",
				"And a benchmark comparison:",
				"",
				"| Algorithm | Time Complexity | Space Complexity |",
				"| --- | --- | --- |",
				"| Quicksort | O(n log n) | O(log n) |",
				"| Mergesort | O(n log n) | O(n) |",
			].join("\n");

			const parsed = parseObsidianMarkdown(markdown);
			const chunks = chunkObsidianDocument(parsed, markdown, { maxTokens: 500 });

			// Fits in token budget, must remain a single chunk preserving code and table
			assert.equal(chunks.length, 1);
			const chunk = chunks[0]!;
			assert.equal(chunk.hasCodeBlock, true);
			assert.equal(chunk.hasTable, true);
			assert.ok(chunk.content.includes("def quicksort(arr):"));
			assert.ok(chunk.content.includes("| Quicksort |"));
			assert.equal(markdown.slice(chunk.range.startOffset, chunk.range.endOffset), chunk.content);
		});

		it("preserves LaTeX math equations intact and flags hasEquation", () => {
			const markdown = [
				"# Wave Equation",
				"The time-dependent Schrödinger equation is given by:",
				"",
				"$$",
				"i \\hbar \\frac{\\partial}{\\partial t} \\Psi(\\mathbf{r}, t) = \\hat{H} \\Psi(\\mathbf{r}, t)",
				"$$",
				"",
				"where $\\hat{H}$ is the Hamiltonian operator.",
			].join("\n");

			const parsed = parseObsidianMarkdown(markdown);
			const chunks = chunkObsidianDocument(parsed, markdown, { maxTokens: 500 });

			assert.equal(chunks.length, 1);
			const chunk = chunks[0]!;
			assert.equal(chunk.hasEquation, true);
			assert.ok(chunk.content.includes("i \\hbar \\frac{\\partial}{\\partial t}"));
			assert.equal(markdown.slice(chunk.range.startOffset, chunk.range.endOffset), chunk.content);
		});

		it("indexes block references (^block-id) into blockIds array", () => {
			const markdown = [
				"# Key Concepts",
				"Energy is quantized in discrete packets called photons. ^energy-quantization",
				"",
				"Mass-energy equivalence establishes $E = mc^2$. ^mass-energy",
			].join("\n");

			const parsed = parseObsidianMarkdown(markdown);
			const chunks = chunkObsidianDocument(parsed, markdown);

			assert.equal(chunks.length, 1);
			const chunk = chunks[0]!;
			assert.ok(chunk.blockIds);
			assert.ok(chunk.blockIds.includes("energy-quantization"));
			assert.ok(chunk.blockIds.includes("mass-energy"));
		});
	});

	// ─── 3. Character Offsets & Byte-Perfect Alignment ──────────────────────────

	describe("Character Offsets & Byte-Perfect Slicing", () => {
		it("verifies rawContent.slice(startOffset, endOffset) === chunk.content across all chunks", () => {
			const markdown = [
				"# Section One",
				"Alpha line one.",
				"Alpha line two.",
				"",
				"## Section Two",
				"Beta line one.",
				"",
				"### Section Three",
				"Gamma line one.",
			].join("\n");

			const parsed = parseObsidianMarkdown(markdown);
			const chunks = chunkObsidianDocument(parsed, markdown, { maxTokens: 20 });

			assert.ok(chunks.length >= 3);
			for (const chunk of chunks) {
				const slice = markdown.slice(chunk.range.startOffset, chunk.range.endOffset);
				assert.equal(
					slice,
					chunk.content,
					`Chunk slice must match content exactly for chunk id ${chunk.id}`,
				);
				assert.ok(chunk.range.startOffset >= 0);
				assert.ok(chunk.range.endOffset > chunk.range.startOffset);
			}
		});
	});

	// ─── 4. Splitting Large Sections & Token Budgets ────────────────────────────

	describe("Large Section Splitting & Token Budgets", () => {
		it("splits large section exceeding maxTokens at paragraph boundaries while retaining heading context", () => {
			const p1 = "First paragraph detailing the experimental apparatus and initial setup conditions.";
			const p2 = "Second paragraph analyzing measurement anomalies and statistical significance.";
			const p3 = "Third paragraph drawing conclusions regarding the validity of the hypothesis.";

			const markdown = [
				"# Long Section",
				p1,
				"",
				p2,
				"",
				p3,
			].join("\n");

			const parsed = parseObsidianMarkdown(markdown);
			// Set tight token budget so each paragraph requires its own chunk
			const chunks = chunkObsidianDocument(parsed, markdown, { maxTokens: 25 });

			assert.ok(chunks.length >= 3, `Expected at least 3 chunks, got ${chunks.length}`);

			// Verify heading context is retained on all chunks from this section
			for (const chunk of chunks) {
				assert.equal(chunk.heading, "Long Section");
				assert.deepEqual(chunk.headingHierarchy, ["Long Section"]);
				assert.ok(chunk.tokenEstimate <= 30);
				assert.equal(markdown.slice(chunk.range.startOffset, chunk.range.endOffset), chunk.content);
			}
		});
	});

	// ─── 5. Token Estimation & Determinism ──────────────────────────────────────

	describe("Token Estimation & Deterministic IDs", () => {
		it("accurately estimates tokens (~4 chars per token)", () => {
			assert.equal(estimateMarkdownTokens(""), 0);
			assert.equal(estimateMarkdownTokens("abcd"), 1);
			assert.equal(estimateMarkdownTokens("abcdefgh"), 2);
			assert.equal(estimateMarkdownTokens("1234567890"), 3);
		});

		it("generates deterministic chunk IDs across runs", () => {
			const markdown = "# Heading\nSome content here.";
			const parsed = parseObsidianMarkdown(markdown, "test.md");

			const run1 = chunkObsidianDocument(parsed, markdown, { maxTokens: 500 });
			const run2 = chunkObsidianDocument(parsed, markdown, { maxTokens: 500 });

			assert.equal(run1.length, 1);
			assert.equal(run2.length, 1);
			assert.equal(run1[0]!.id, run2[0]!.id);
			assert.ok(run1[0]!.id.startsWith("chk_"));
		});

		it("validates chunks and options with Zod schemas", () => {
			const markdown = "# Test\nValid chunk.";
			const parsed = parseObsidianMarkdown(markdown);
			const chunks = chunkObsidianDocument(parsed, markdown);

			const validatedChunk = validateMarkdownChunk(chunks[0]);
			assert.equal(validatedChunk.id, chunks[0]!.id);

			const validatedOptions = validateChunkerOptions({ maxTokens: 400, minTokens: 30 });
			assert.equal(validatedOptions.maxTokens, 400);
			assert.equal(validatedOptions.minTokens, 30);
		});
	});

	// ─── 6. Boundary Conditions ─────────────────────────────────────────────────

	describe("Boundary Conditions: Empty, Frontmatter, Unicode, CRLF, Massive Code", () => {
		it("returns empty array for empty or whitespace-only content", () => {
			const parsedEmpty = parseObsidianMarkdown("");
			assert.deepEqual(chunkObsidianDocument(parsedEmpty, ""), []);

			const parsedWhitespace = parseObsidianMarkdown("   \n\n  \t ");
			assert.deepEqual(chunkObsidianDocument(parsedWhitespace, "   \n\n  \t "), []);
		});

		it("returns empty array for documents with only frontmatter", () => {
			const markdown = [
				"---",
				"title: Metadata Note",
				"tags: [physics, quantum]",
				"---",
			].join("\n");

			const parsed = parseObsidianMarkdown(markdown);
			const chunks = chunkObsidianDocument(parsed, markdown);
			assert.deepEqual(chunks, []);
		});

		it("handles CRLF (\\r\\n) line endings without offset drift", () => {
			const markdown = "# CRLF Section\r\nFirst CRLF line.\r\n\r\nSecond CRLF line.\r\n";
			const parsed = parseObsidianMarkdown(markdown);
			const chunks = chunkObsidianDocument(parsed, markdown);

			assert.equal(chunks.length, 1);
			const chunk = chunks[0]!;
			assert.equal(markdown.slice(chunk.range.startOffset, chunk.range.endOffset), chunk.content);
		});

		it("handles Unicode emojis and multi-byte characters cleanly", () => {
			const markdown = [
				"# Unicode Section 🔬",
				"Quantum entanglement 🌌 is spooky action at a distance ✨.",
				"Superposition ⚛️ allows simultaneous states 🐱📦.",
			].join("\n");

			const parsed = parseObsidianMarkdown(markdown);
			const chunks = chunkObsidianDocument(parsed, markdown);

			assert.equal(chunks.length, 1);
			const chunk = chunks[0]!;
			assert.ok(chunk.content.includes("🔬"));
			assert.ok(chunk.content.includes("🐱📦"));
			assert.equal(markdown.slice(chunk.range.startOffset, chunk.range.endOffset), chunk.content);
		});

		it("splits a massive code block exceeding maxTokens along line boundaries", () => {
			const codeLines = Array.from({ length: 60 }, (_, i) => `    line_${i} = do_work(${i})`);
			const markdown = [
				"# Big Code Section",
				"```python",
				...codeLines,
				"```",
			].join("\n");

			const parsed = parseObsidianMarkdown(markdown);
			// Budget is small so 60 lines must split across multiple chunks
			const chunks = chunkObsidianDocument(parsed, markdown, { maxTokens: 50 });

			assert.ok(chunks.length > 1, `Expected multiple chunks, got ${chunks.length}`);
			for (const chunk of chunks) {
				assert.equal(chunk.heading, "Big Code Section");
				assert.equal(markdown.slice(chunk.range.startOffset, chunk.range.endOffset), chunk.content);
			}

			// Code-containing chunks must have hasCodeBlock flag
			const codeChunks = chunks.filter((c) => c.content.includes("line_"));
			assert.ok(codeChunks.length > 1, "Must have multiple code block chunks");
			for (const chunk of codeChunks) {
				assert.equal(chunk.hasCodeBlock, true);
			}
		});
	});

	// ─── 7. Fixture Vault Ingestion ─────────────────────────────────────────────

	describe("Fixture Notes Ingestion", () => {
		it("chunks Physics/Quantum/Schrodinger.md preserving callouts and math equations", () => {
			const filePath = path.join(FIXTURES_DIR, "Physics/Quantum/Schrodinger.md");
			const content = fs.readFileSync(filePath, "utf-8");
			const parsed = parseObsidianMarkdown(content, "Physics/Quantum/Schrodinger.md");

			const chunks = chunkObsidianDocument(parsed, content, { maxTokens: 400 });

			assert.ok(chunks.length >= 3, `Expected at least 3 sections/chunks, got ${chunks.length}`);

			// Verify all chunks slice cleanly
			for (const chunk of chunks) {
				assert.equal(
					content.slice(chunk.range.startOffset, chunk.range.endOffset),
					chunk.content,
				);
			}

			// Ensure math equations and callouts are detected
			const mathChunk = chunks.find((c) => c.hasEquation);
			assert.ok(mathChunk, "At least one chunk must have LaTeX math equation");

			// Ensure callout text is preserved
			const calloutChunk = chunks.find((c) => c.content.includes("[!note]"));
			assert.ok(calloutChunk, "At least one chunk must preserve the callout");

			// Ensure block reference eq1 is captured
			const eq1Chunk = chunks.find((c) => c.blockIds?.includes("eq1"));
			assert.ok(eq1Chunk, "Block reference ^eq1 must be captured in blockIds");
		});

		it("chunks Physics/Classical/Newton.md preserving tables and sections", () => {
			const filePath = path.join(FIXTURES_DIR, "Physics/Classical/Newton.md");
			const content = fs.readFileSync(filePath, "utf-8");
			const parsed = parseObsidianMarkdown(content, "Physics/Classical/Newton.md");

			const chunks = chunkObsidianDocument(parsed, content, { maxTokens: 400 });

			assert.ok(chunks.length >= 2, `Expected at least 2 chunks, got ${chunks.length}`);
			for (const chunk of chunks) {
				assert.equal(
					content.slice(chunk.range.startOffset, chunk.range.endOffset),
					chunk.content,
				);
			}

			const tableChunk = chunks.find((c) => c.hasTable);
			assert.ok(tableChunk, "Must contain table chunk in Newton note");

			const mathChunk = chunks.find((c) => c.hasEquation);
			assert.ok(mathChunk, "Must contain gravitation equation in Newton note");
		});

		it("guarantees disjoint non-overlapping ranges on Schrodinger.md with zero subsection duplication", () => {
			const filePath = path.join(FIXTURES_DIR, "Physics/Quantum/Schrodinger.md");
			const content = fs.readFileSync(filePath, "utf-8");
			const parsed = parseObsidianMarkdown(content, "Physics/Quantum/Schrodinger.md");

			const chunks = chunkObsidianDocument(parsed, content, { maxTokens: 400 });

			// Verify disjoint ranges
			for (let i = 0; i < chunks.length - 1; i++) {
				assert.ok(
					chunks[i]!.range.endOffset <= chunks[i + 1]!.range.startOffset,
					`Chunks ${i} and ${i + 1} must be strictly disjoint: ${chunks[i]!.range.endOffset} <= ${chunks[i + 1]!.range.startOffset}`,
				);
			}

			// Verify parent H1 chunk does NOT contain child H2 titles or content
			const h1Chunk = chunks.find((c) => c.heading === "Erwin Schrödinger and Wave Mechanics");
			assert.ok(h1Chunk, "H1 chunk must exist");
			assert.ok(
				!h1Chunk.content.includes("The Time-Dependent Schrödinger Equation"),
				"Parent H1 chunk must not duplicate child H2 heading",
			);
			assert.ok(
				!h1Chunk.content.includes("Probabilistic Interpretation and Normalization"),
				"Parent H1 chunk must not duplicate child H2 subsection",
			);

			// Verify 100% character slice match
			for (const chunk of chunks) {
				assert.equal(
					content.slice(chunk.range.startOffset, chunk.range.endOffset),
					chunk.content,
				);
			}
		});

		it("guarantees disjoint non-overlapping ranges on LinearAlgebra.md with zero subsection duplication", () => {
			const filePath = path.join(FIXTURES_DIR, "Math/LinearAlgebra.md");
			const content = fs.readFileSync(filePath, "utf-8");
			const parsed = parseObsidianMarkdown(content, "Math/LinearAlgebra.md");

			const chunks = chunkObsidianDocument(parsed, content, { maxTokens: 400 });

			assert.ok(chunks.length >= 4, `Expected at least 4 chunks, got ${chunks.length}`);

			// Verify strictly disjoint ranges
			for (let i = 0; i < chunks.length - 1; i++) {
				assert.ok(
					chunks[i]!.range.endOffset <= chunks[i + 1]!.range.startOffset,
					`LinearAlgebra chunk ${i} and ${i + 1} must be disjoint: ${chunks[i]!.range.endOffset} <= ${chunks[i + 1]!.range.startOffset}`,
				);
			}

			// Verify parent H1 chunk does NOT contain child subsections
			const h1Chunk = chunks.find((c) => c.heading === "Linear Algebra");
			assert.ok(h1Chunk, "Linear Algebra H1 chunk must exist");
			assert.ok(
				!h1Chunk.content.includes("Vector Spaces and Inner Products"),
				"H1 must not duplicate Vector Spaces",
			);
			assert.ok(
				!h1Chunk.content.includes("Matrices and Transformations"),
				"H1 must not duplicate Matrices",
			);
			assert.ok(
				!h1Chunk.content.includes("Eigenvalues and Eigenvectors"),
				"H1 must not duplicate Eigenvalues",
			);

			// Verify character offset invariant
			for (const chunk of chunks) {
				assert.equal(
					content.slice(chunk.range.startOffset, chunk.range.endOffset),
					chunk.content,
				);
			}
		});

		it("handles synthetic nested heading hierarchies (H1 -> H2 -> H3) with disjoint ranges and zero duplication", () => {
			const markdown = [
				"# Top Topic",
				"Top level introduction.",
				"",
				"## Sub Topic",
				"Sub level content.",
				"",
				"### Leaf Topic",
				"Leaf level details.",
			].join("\n");

			const parsed = parseObsidianMarkdown(markdown);
			const chunks = chunkObsidianDocument(parsed, markdown);

			assert.equal(chunks.length, 3);
			for (let i = 0; i < chunks.length - 1; i++) {
				assert.ok(
					chunks[i]!.range.endOffset <= chunks[i + 1]!.range.startOffset,
					`Synthetic chunk ${i} and ${i + 1} must be disjoint`,
				);
			}

			assert.ok(!chunks[0]!.content.includes("Sub level content"));
			assert.ok(!chunks[0]!.content.includes("Leaf level details"));
			assert.ok(!chunks[1]!.content.includes("Leaf level details"));

			for (const chunk of chunks) {
				assert.equal(
					markdown.slice(chunk.range.startOffset, chunk.range.endOffset),
					chunk.content,
				);
			}
		});

		it("handles ancestor heading without direct body before child heading cleanly without duplication", () => {
			const markdown = [
				"# Parent Without Body",
				"## Child One",
				"Child one content text.",
				"## Child Two",
				"Child two content text.",
			].join("\n");

			const parsed = parseObsidianMarkdown(markdown);
			const chunks = chunkObsidianDocument(parsed, markdown);

			assert.equal(chunks.length, 2);
			assert.deepEqual(chunks[0]!.headingHierarchy, ["Parent Without Body", "Child One"]);
			assert.deepEqual(chunks[1]!.headingHierarchy, ["Parent Without Body", "Child Two"]);
			assert.ok(chunks[0]!.range.endOffset <= chunks[1]!.range.startOffset);

			for (const chunk of chunks) {
				assert.equal(
					markdown.slice(chunk.range.startOffset, chunk.range.endOffset),
					chunk.content,
				);
			}
		});
	});

	// ─── 8. ChunkerOptions: minTokens and overlapTokens ─────────────────────────

	describe("ChunkerOptions: minTokens and overlapTokens Fulfillment", () => {
		it("filters out chunks below minTokens when other satisfying chunks exist", () => {
			const markdown = [
				"# Stub Section",
				"Small.",
				"",
				"# Main Section",
				"This is a substantially larger section with ample content to easily exceed the twenty token threshold requirement.",
			].join("\n");

			const parsed = parseObsidianMarkdown(markdown);

			// Without minTokens: both chunks emitted
			const allChunks = chunkObsidianDocument(parsed, markdown);
			assert.equal(allChunks.length, 2);

			// With minTokens: 20 -> stub section (< 20 tokens) is filtered out
			const filteredChunks = chunkObsidianDocument(parsed, markdown, { minTokens: 20 });
			assert.equal(filteredChunks.length, 1);
			assert.equal(filteredChunks[0]!.heading, "Main Section");
			assert.ok(filteredChunks[0]!.tokenEstimate >= 20);
			assert.equal(
				markdown.slice(filteredChunks[0]!.range.startOffset, filteredChunks[0]!.range.endOffset),
				filteredChunks[0]!.content,
			);
		});

		it("preserves chunks when all content in the document is below minTokens", () => {
			const markdown = [
				"# Concise Note",
				"Brief statement.",
			].join("\n");

			const parsed = parseObsidianMarkdown(markdown);
			const chunks = chunkObsidianDocument(parsed, markdown, { minTokens: 50000 });

			assert.equal(chunks.length, 1);
			assert.equal(
				markdown.slice(chunks[0]!.range.startOffset, chunks[0]!.range.endOffset),
				chunks[0]!.content,
			);
		});

		it("produces overlapping slices when overlapTokens > 0 on split large blocks", () => {
			const sentence = "The quantum harmonic oscillator exhibits discrete eigenvalues in bound states. ";
			const markdown = "# Quantum Mechanics\n" + sentence.repeat(15);
			const parsed = parseObsidianMarkdown(markdown);

			// Default: disjoint chunks (overlapTokens = 0)
			const disjoint = chunkObsidianDocument(parsed, markdown, { maxTokens: 40, overlapTokens: 0 });
			for (let i = 0; i < disjoint.length - 1; i++) {
				assert.ok(
					disjoint[i]!.range.endOffset <= disjoint[i + 1]!.range.startOffset,
					`Disjoint chunks must not overlap: ${disjoint[i]!.range.endOffset} <= ${disjoint[i + 1]!.range.startOffset}`,
				);
			}

			// Overlap: adjacent split slices rewind by up to overlapTokens
			const overlapping = chunkObsidianDocument(parsed, markdown, { maxTokens: 40, overlapTokens: 15 });
			assert.ok(overlapping.length > 1, "Should produce multiple slices");

			// Check that adjacent slices from the split block overlap
			let foundOverlap = false;
			for (let i = 0; i < overlapping.length - 1; i++) {
				if (overlapping[i + 1]!.range.startOffset < overlapping[i]!.range.endOffset) {
					foundOverlap = true;
				}
			}
			assert.ok(foundOverlap, "Adjacent slices must overlap when overlapTokens > 0");

			// Verify 100% character offset fidelity across ALL overlapping chunks
			for (const chunk of overlapping) {
				assert.equal(
					markdown.slice(chunk.range.startOffset, chunk.range.endOffset),
					chunk.content,
					`Slice mismatch for chunk ${chunk.id}`,
				);
			}
		});
	});
});
