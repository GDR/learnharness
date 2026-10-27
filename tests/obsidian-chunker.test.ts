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

		it("preserves deep ancestor heading hierarchy (H1..H3)", () => {
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
	});
});
