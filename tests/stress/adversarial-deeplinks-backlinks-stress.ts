/**
 * Empirical Adversarial Stress Test Suite for PR #17 (Milestone B Slice 4)
 * Target: Deep-Link Generator, Wiki-Link Resolution, Backlinks, Rename Refactor
 *
 * Requirements tested:
 * 1. Mega-vault scale: 500 documents with 5,000+ wikilinks across complex nested folder structures.
 * 2. Benchmark buildBacklinkIndex: measure elapsed time for 500 documents (<200ms target).
 * 3. High-degree nodes: a single "hub" note referenced by 200 different documents.
 * 4. Large-scale rename cascade: rename the hub note and verify computeRenameRefactor updates all 200 documents.
 * 5. Memory leak check: run 200 consecutive index & rename cycles in a tight loop and assert memory stability.
 * 6. Adversarial boundaries & path resolution integrity: verify tier fallback and corruptions.
 */

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import v8 from "node:v8";
import vm from "node:vm";

import {
	createObsidianDeepLink,
	parseObsidianDeepLink,
	resolveWikiLink,
	buildBacklinkIndex,
	computeRenameRefactor,
	validateObsidianDeepLinkOptions,
	validateWikiLinkResolution,
	validateBacklinkReference,
	validateRenameRefactorResult,
	parseObsidianMarkdown,
} from "../../src/core/index.ts";
import type {
	ObsidianDeepLinkOptions,
	WikiLinkResolution,
	BacklinkReference,
	RenameRefactorResult,
	ParsedObsidianDocument,
	ParsedWikiLink,
} from "../../src/core/contracts/obsidian.ts";

function hr(title: string): void {
	console.log(`\n============================================================`);
	console.log(`>>> ${title}`);
	console.log(`============================================================`);
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 1: DEEP-LINK GENERATOR & PARSER STRESS
// ─────────────────────────────────────────────────────────────────────────────
function runDeepLinkStressTest(): { passed: number; failed: number } {
	hr("Suite 1: Deep-Link Generator & Parser Stress & Boundary Invariants");
	let passed = 0;
	let failed = 0;

	// 1.1 Round-trip across diverse paths, emojis, Unicode, and anchors
	const testCases: ObsidianDeepLinkOptions[] = [
		{ vaultName: "PersonalVault", filePath: "Notes/Quantum.md" },
		{ vaultName: "PersonalVault", filePath: "Folder/Sub/Deep Note.mdx" },
		{ vaultName: "PersonalVault", filePath: "Notes/Math", heading: "Theorem 1" },
		{ vaultName: "PersonalVault", filePath: "Notes/Physics", blockId: "eq-euler" },
		{ vaultName: "PersonalVault", filePath: "Notes/Physics", blockId: "^eq-euler" },
		{ vaultName: "PersonalVault", filePath: "Notes/Physics", heading: "#Intro" },
		{ vaultName: "Vault With Spaces", filePath: "Folder With Spaces/Note With Spaces.md" },
		{ vaultName: "База Знаний 🚀", filePath: "Папка/Заметка №1.md", heading: "Введение & Обзор" },
		{ vaultName: "Vault", filePath: "a\\b\\c\\d.md" },
		{ vaultName: "Vault", filePath: "./notes/note.md" },
		{ vaultName: "Vault", filePath: "/notes/note.md/" },
	];

	for (const tc of testCases) {
		const uri = createObsidianDeepLink(tc);
		const parsed = parseObsidianDeepLink(uri);
		assert.ok(parsed, `Failed to parse deep link: ${uri}`);
		assert.equal(parsed.vaultName, tc.vaultName.trim());
		const expectedNorm = tc.filePath
			.replace(/\\/g, "/")
			.replace(/^\.\//, "")
			.replace(/^\/+|\/+$/g, "")
			.replace(/\.mdx?$/i, "");
		assert.equal(parsed.filePath, expectedNorm);
		if (tc.heading) {
			assert.equal(parsed.heading, tc.heading.trim().replace(/^#/, ""));
		}
		if (tc.blockId) {
			assert.equal(parsed.blockId, tc.blockId.trim().replace(/^\^/, ""));
		}
		passed++;
	}

	// 1.2 Shorthand format: obsidian://vault/VaultName/Path
	const shorthand = parseObsidianDeepLink("obsidian://vault/MyVault/Notes/Test#Heading");
	assert.ok(shorthand);
	assert.equal(shorthand.vaultName, "MyVault");
	assert.equal(shorthand.filePath, "Notes/Test");
	assert.equal(shorthand.heading, "Heading");
	passed++;

	// 1.3 Invalid inputs rejection
	const invalidInputs: unknown[] = [
		{ vaultName: "", filePath: "Note" },
		{ vaultName: "   ", filePath: "Note" },
		{ vaultName: "Vault", filePath: "" },
		{ vaultName: "Vault", filePath: "   " },
		{ vaultName: "Vault", filePath: ".md" },
	];

	for (const inv of invalidInputs) {
		assert.throws(
			// @ts-expect-error testing invalid inputs
			() => createObsidianDeepLink(inv),
			/vaultName|filePath/,
		);
		passed++;
	}

	// 1.3b Quirk observation: "/././//" normalizes to "./." instead of throwing
	const dotQuirkUri = createObsidianDeepLink({ vaultName: "Vault", filePath: "/././//" });
	assert.ok(dotQuirkUri.includes("file=.%2F."));
	passed++;

	// 1.4 Invalid URIs return null
	const invalidUris = [
		"",
		"not-a-uri",
		"http://open?vault=V&file=F",
		"obsidian://other?vault=V&file=F",
		"obsidian://open?file=F",
		"obsidian://open?vault=V",
		"obsidian://vault/SinglePart",
	];

	for (const u of invalidUris) {
		assert.equal(parseObsidianDeepLink(u), null);
		passed++;
	}

	console.log(`Suite 1 Complete: ${passed} assertions passed.`);
	return { passed, failed };
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 2: WIKI-LINK RESOLUTION & ADVERSARIAL PATH CORRUPTION CHECK
// ─────────────────────────────────────────────────────────────────────────────
function runWikiLinkAdversarialTest(): { passed: number; failed: number; bugDetected: boolean } {
	hr("Suite 2: Wiki-Link Resolution Tiers & Adversarial Path Integrity");
	let passed = 0;
	let failed = 0;
	let bugDetected = false;

	const availablePaths = [
		"Cooking/Quantum.md",
		"Math/Algebra.md",
		"Physics/Classical/Mechanics.md",
		"Notes/SameName.md",
		"Archive/SameName.md",
		"Index.md",
	];

	// 2.1 Self anchors
	const selfHeading = resolveWikiLink("[[#Section]]", availablePaths, "Index.md");
	assert.equal(selfHeading.status, "resolved");
	assert.equal(selfHeading.resolvedPath, "Index.md");
	assert.deepEqual(selfHeading.subpath, { type: "heading", value: "Section" });
	passed++;

	const selfBlock = resolveWikiLink("[[#^quote-1]]", availablePaths, "Index.md");
	assert.equal(selfBlock.status, "resolved");
	assert.equal(selfBlock.resolvedPath, "Index.md");
	assert.deepEqual(selfBlock.subpath, { type: "block", value: "quote-1" });
	passed++;

	// 2.2 Ambiguity detection
	const amb = resolveWikiLink("[[SameName]]", availablePaths, "Index.md");
	assert.equal(amb.status, "ambiguous");
	assert.equal(amb.candidates?.length, 2);
	passed++;

	// 2.3 Exact path resolution
	const exact = resolveWikiLink("[[Physics/Classical/Mechanics]]", availablePaths, "Index.md");
	assert.equal(exact.status, "resolved");
	assert.equal(exact.resolvedPath, "Physics/Classical/Mechanics.md");
	passed++;

	// 2.4 Relative path resolution
	const rel = resolveWikiLink("./SameName", availablePaths, "Notes/Other.md");
	assert.equal(rel.status, "resolved");
	assert.equal(rel.resolvedPath, "Notes/SameName.md");
	passed++;

	// 2.5 ADVERSARIAL PATH INTEGRITY CHECK (Finding the Tier D Path Bug!)
	// When a user specifies an explicit folder path `[[Physics/Quantum]]`,
	// but `Physics/Quantum` does NOT exist in the vault (only `Cooking/Quantum.md` exists),
	// does resolveWikiLink incorrectly resolve it to `Cooking/Quantum.md`?
	const pathLeakCheck = resolveWikiLink("Physics/Quantum", availablePaths, "Index.md");
	console.log("Adversarial Check: resolveWikiLink('Physics/Quantum'):");
	console.log(` - Status: ${pathLeakCheck.status}`);
	console.log(` - ResolvedPath: ${pathLeakCheck.resolvedPath ?? "none"}`);

	if (pathLeakCheck.status === "resolved" && pathLeakCheck.resolvedPath === "Cooking/Quantum.md") {
		console.warn("⚠️ CRITICAL BUG CONFIRMED: resolveWikiLink Tier D incorrectly resolved explicit path 'Physics/Quantum' to 'Cooking/Quantum.md'!");
		console.warn("   Root cause: Tier D checks ciBaseMatches without checking `!isPath`!");
		bugDetected = true;
		failed++;
	} else if (pathLeakCheck.status === "unresolved") {
		console.log("✓ Expected: 'Physics/Quantum' is correctly unresolved.");
		passed++;
	}

	console.log(`Suite 2 Complete: ${passed} passed, ${failed} failed (Bug detected: ${bugDetected}).`);
	return { passed, failed, bugDetected };
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 3: MEGA-VAULT SCALE & BACKLINK INDEX BENCHMARK (<200MS TARGET)
// ─────────────────────────────────────────────────────────────────────────────
function runMegaVaultBenchmark(): {
	docCount: number;
	linkCount: number;
	hubBacklinkCount: number;
	elapsedMs: number;
	meetsBudget: boolean;
	hubBacklinksVerified: boolean;
} {
	hr("Suite 3: Mega-Vault Scale & Backlink Index Benchmark");

	const NUM_DOCS = 500;
	const HUB_PATH = "hub/CentralHub.md";
	const docs: Array<{
		filePath: string;
		rawContent: string;
		parsed: ParsedObsidianDocument;
	}> = [];

	const allPaths: string[] = [HUB_PATH];
	const folders = [
		"core",
		"projects/alpha",
		"projects/beta",
		"archive/2024/notes",
		"archive/2025/notes",
		"archive/2026/notes",
		"math/advanced",
		"physics/quantum",
		"reference/specs",
		"hub",
	];

	for (let i = 1; i < NUM_DOCS; i++) {
		const folder = folders[i % folders.length];
		allPaths.push(`${folder}/note_${i}.md`);
	}

	let totalLinks = 0;
	const hubReferencingDocs: string[] = [];

	// Generate 500 documents with 5,000+ wikilinks
	for (let i = 0; i < NUM_DOCS; i++) {
		const filePath = allPaths[i];
		if (!filePath) continue;
		const links: ParsedWikiLink[] = [];
		let content = `# Document ${i}\n\n`;

		// 200 documents reference the CentralHub note with diverse syntax
		if (i > 0 && i <= 200) {
			hubReferencingDocs.push(filePath);
			let linkText = "";
			let target = "";
			let alias: string | undefined;
			let subpath: { kind: "heading" | "block"; value: string } | undefined;

			const variant = i % 5;
			if (variant === 0) {
				linkText = "[[CentralHub]]";
				target = "CentralHub";
			} else if (variant === 1) {
				linkText = "[[CentralHub|The Central Hub]]";
				target = "CentralHub";
				alias = "The Central Hub";
			} else if (variant === 2) {
				linkText = "[[hub/CentralHub#Overview]]";
				target = "hub/CentralHub";
				subpath = { kind: "heading", value: "Overview" };
			} else if (variant === 3) {
				linkText = "[[CentralHub#^quote-42]]";
				target = "CentralHub";
				subpath = { kind: "block", value: "quote-42" };
			} else {
				linkText = "[[hub/CentralHub.md|Hub Doc]]";
				target = "hub/CentralHub.md";
				alias = "Hub Doc";
			}

			const startOffset = content.length;
			content += `Hub citation: ${linkText} in paragraph.\n`;
			const endOffset = startOffset + `Hub citation: ${linkText}`.length;

			links.push({
				target,
				alias,
				subpath,
				range: { startOffset: startOffset + 14, endOffset },
			});
			totalLinks++;
		}

		// Add 10 additional cross-document links per document
		for (let j = 0; j < 10; j++) {
			const targetIdx = (i + j + 1) % NUM_DOCS;
			const targetPath = allPaths[targetIdx];
			const targetBase = `note_${targetIdx}`;
			const linkText = `[[${targetBase}]]`;

			const startOffset = content.length;
			content += `Related topic: ${linkText} section.\n`;
			const endOffset = startOffset + `Related topic: ${linkText}`.length;

			links.push({
				target: targetBase,
				range: { startOffset: startOffset + 15, endOffset },
			});
			totalLinks++;
		}

		docs.push({
			filePath,
			rawContent: content,
			parsed: {
				filePath,
				frontmatter: {},
				headings: [{ level: 1, text: `Document ${i}`, slug: `document-${i}`, range: { startOffset: 0, endOffset: 12 } }],
				sections: [],
				blocks: [],
				wikiLinks: links,
				tags: [],
				callouts: [],
				equations: [],
				tables: [],
			},
		});
	}

	console.log(`Corpus generated: ${docs.length} documents, ${totalLinks} wikilinks across ${folders.length} directories.`);

	// Warmup run
	buildBacklinkIndex(docs.slice(0, 10));

	// Benchmark measurement
	const t0 = performance.now();
	const index = buildBacklinkIndex(docs);
	const elapsedMs = performance.now() - t0;

	console.log(`Benchmark buildBacklinkIndex:`);
	console.log(` - Elapsed time: ${elapsedMs.toFixed(2)} ms`);
	console.log(` - Target budget: <200.00 ms`);
	const meetsBudget = elapsedMs < 200.0;
	console.log(` - Result: ${meetsBudget ? "PASS (<200ms)" : "FAIL (>200ms target exceeded)"}`);

	// High-degree hub node verification
	const hubBacklinks = index.get(HUB_PATH) ?? [];
	console.log(`\nHigh-Degree Hub Node Verification (${HUB_PATH}):`);
	console.log(` - Expected backlinks: 200`);
	console.log(` - Captured backlinks: ${hubBacklinks.length}`);

	let hubBacklinksVerified = hubBacklinks.length === 200;
	if (hubBacklinksVerified) {
		const uniqueSources = new Set(hubBacklinks.map((b) => b.sourceFilePath));
		assert.equal(uniqueSources.size, 200, "All 200 backlink source paths must be distinct");
		for (const bl of hubBacklinks) {
			assert.doesNotThrow(() => validateBacklinkReference(bl));
			assert.ok(bl.contextSnippet.length > 0, "Context snippet must not be empty");
		}
		console.log("✓ All 200 backlinks validated with distinct sources, valid snippets, and correct ranges.");
	} else {
		console.warn(`⚠️ High-degree hub note verification failed: captured ${hubBacklinks.length} instead of 200!`);
	}

	return {
		docCount: docs.length,
		linkCount: totalLinks,
		hubBacklinkCount: hubBacklinks.length,
		elapsedMs,
		meetsBudget,
		hubBacklinksVerified,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 4: LARGE-SCALE RENAME CASCADE & ZERO-CORRUPTION CHECK
// ─────────────────────────────────────────────────────────────────────────────
function runRenameCascadeStressTest(): {
	renamedDocsCount: number;
	zeroCorruption: boolean;
	syntaxValid: boolean;
	durationMs: number;
	pathBugCascadeDetected: boolean;
} {
	hr("Suite 4: Large-Scale Rename Cascade & AST Refactoring Invariant Check");

	const NUM_DOCS = 500;
	const OLD_PATH = "hub/CentralHub.md";
	const NEW_PATH = "knowledge/core/MasterHub.md";

	const docs: Array<{
		filePath: string;
		content: string;
		parsed: ParsedObsidianDocument;
	}> = [];

	const allPaths: string[] = [OLD_PATH];
	for (let i = 1; i < NUM_DOCS; i++) {
		allPaths.push(`folder_${i % 10}/note_${i}.md`);
	}

	// 200 documents reference the CentralHub note
	for (let i = 0; i < NUM_DOCS; i++) {
		const filePath = allPaths[i];
		if (!filePath) continue;
		const links: ParsedWikiLink[] = [];
		let content = `# Document ${i}\n\n`;

		if (i > 0 && i <= 200) {
			let linkText = "";
			let target = "";
			let alias: string | undefined;
			let subpath: { kind: "heading" | "block"; value: string } | undefined;

			const variant = i % 5;
			if (variant === 0) {
				linkText = "[[CentralHub]]";
				target = "CentralHub";
			} else if (variant === 1) {
				linkText = "[[CentralHub|The Central Hub]]";
				target = "CentralHub";
				alias = "The Central Hub";
			} else if (variant === 2) {
				linkText = "[[hub/CentralHub#Overview]]";
				target = "hub/CentralHub";
				subpath = { kind: "heading", value: "Overview" };
			} else if (variant === 3) {
				linkText = "[[CentralHub#^quote-42]]";
				target = "CentralHub";
				subpath = { kind: "block", value: "quote-42" };
			} else {
				linkText = "[[hub/CentralHub.md|Hub Doc]]";
				target = "hub/CentralHub.md";
				alias = "Hub Doc";
			}

			const startOffset = content.length;
			content += `Hub reference: ${linkText}.\n`;
			const endOffset = startOffset + `Hub reference: ${linkText}`.length;

			links.push({
				target,
				alias,
				subpath,
				range: { startOffset: startOffset + 15, endOffset },
			});
		}

		// Additional cross-links
		for (let j = 0; j < 5; j++) {
			const targetIdx = (i + j + 1) % NUM_DOCS;
			const targetBase = `note_${targetIdx}`;
			const linkText = `[[${targetBase}]]`;
			const startOffset = content.length;
			content += `Cross-ref: ${linkText}.\n`;
			const endOffset = startOffset + `Cross-ref: ${linkText}`.length;
			links.push({
				target: targetBase,
				range: { startOffset: startOffset + 11, endOffset },
			});
		}

		docs.push({
			filePath,
			content,
			parsed: {
				filePath,
				frontmatter: {},
				headings: [{ level: 1, text: `Document ${i}`, slug: `document-${i}`, range: { startOffset: 0, endOffset: 12 } }],
				sections: [],
				blocks: [],
				wikiLinks: links,
				tags: [],
				callouts: [],
				equations: [],
				tables: [],
			},
		});
	}

	const t0 = performance.now();
	const refactorResults = computeRenameRefactor({
		oldPath: OLD_PATH,
		newPath: NEW_PATH,
		documents: docs,
	});
	const durationMs = performance.now() - t0;

	console.log(`Rename Cascade Benchmark:`);
	console.log(` - Refactored documents count: ${refactorResults.length} (expected 200)`);
	console.log(` - Duration: ${durationMs.toFixed(2)} ms`);

	assert.equal(refactorResults.length, 200, "Exactly 200 documents must be refactored");

	let zeroCorruption = true;
	let syntaxValid = true;

	for (const res of refactorResults) {
		assert.doesNotThrow(() => validateRenameRefactorResult(res));
		assert.ok(res.replacementsCount >= 1, "Replacements count must be >= 1");

		// Syntax validity check: re-parse markdown
		const reParsed = parseObsidianMarkdown(res.updatedContent, res.filePath);
		assert.ok(reParsed.wikiLinks.length > 0, "Must contain parsed wikilinks");

		// Verify that all updated links to MasterHub have correct targets
		for (const wl of reParsed.wikiLinks) {
			if (wl.target.includes("MasterHub")) {
				// Must not have broken syntax like [[[[ or unclosed brackets
				if (wl.target.includes("[[") || wl.target.includes("]]")) {
					syntaxValid = false;
				}
			}
		}

		// Zero corruption check outside of the renamed link:
		// Replace "MasterHub" back with "CentralHub" and compare with original
		const reverted = res.updatedContent
			.replace(/knowledge\/core\/MasterHub/g, "hub/CentralHub")
			.replace(/MasterHub/g, "CentralHub");
		if (reverted !== res.originalContent) {
			zeroCorruption = false;
		}
	}

	console.log(` - Syntax Valid: ${syntaxValid}`);
	console.log(` - Zero Corruption: ${zeroCorruption}`);

	// 4.2 Adversarial Rename Cascade Corruption Test (Tier D path bug cascade)
	// If a document references [[Physics/Quantum]] and someone renames Cooking/Quantum.md:
	const adversarialDoc = {
		filePath: "research/physics.md",
		content: "Important reading: [[Physics/Quantum]]. Do not edit.\n",
		parsed: parseObsidianMarkdown(
			"Important reading: [[Physics/Quantum]]. Do not edit.\n",
			"research/physics.md",
		),
	};
	const adversarialDocs = [
		adversarialDoc,
		{
			filePath: "Cooking/Quantum.md",
			content: "# Cooking Quantum",
			parsed: parseObsidianMarkdown("# Cooking Quantum", "Cooking/Quantum.md"),
		},
	];

	const cascadeRes = computeRenameRefactor({
		oldPath: "Cooking/Quantum.md",
		newPath: "Cooking/MolecularGastronomy.md",
		documents: adversarialDocs,
	});

	let pathBugCascadeDetected = false;
	if (cascadeRes.some((r) => r.filePath === "research/physics.md")) {
		console.warn("⚠️ CRITICAL CORRUPTION BUG CONFIRMED: computeRenameRefactor corrupted 'research/physics.md'!");
		console.warn(`   Before: ${adversarialDoc.content.trim()}`);
		console.warn(`   After:  ${cascadeRes[0]?.updatedContent.trim() ?? ""}`);
		pathBugCascadeDetected = true;
	}

	return {
		renamedDocsCount: refactorResults.length,
		zeroCorruption,
		syntaxValid,
		durationMs,
		pathBugCascadeDetected,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 5: MEMORY LEAK CHECK (200 CONSECUTIVE CYCLES)
// ─────────────────────────────────────────────────────────────────────────────
function runMemoryStabilityTest(): {
	cycles: number;
	initialHeapMb: number;
	finalHeapMb: number;
	deltaMb: number;
	isStable: boolean;
} {
	hr("Suite 5: Memory Leak & Stability Stress Test (200 Consecutive Cycles)");

	// Use a 100-doc corpus for 200 tight cycles to prevent benchmark timeout
	const NUM_DOCS = 100;
	const docs: Array<{
		filePath: string;
		content: string;
		rawContent: string;
		parsed: ParsedObsidianDocument;
	}> = [];

	const allPaths = ["hub/CentralHub.md"];
	for (let i = 1; i < NUM_DOCS; i++) {
		allPaths.push(`folder_${i % 5}/note_${i}.md`);
	}

	for (let i = 0; i < NUM_DOCS; i++) {
		const filePath = allPaths[i];
		if (!filePath) continue;
		const links: ParsedWikiLink[] = [];
		let content = `# Note ${i}\n\n`;
		if (i > 0 && i <= 50) {
			const linkText = `[[CentralHub]]`;
			const start = content.length;
			content += `Links to hub: ${linkText}.\n`;
			links.push({
				target: "CentralHub",
				range: { startOffset: start + 14, endOffset: start + 14 + linkText.length },
			});
		}
		for (let j = 0; j < 5; j++) {
			const targetIdx = (i + j + 1) % NUM_DOCS;
			const linkText = `[[note_${targetIdx}]]`;
			const start = content.length;
			content += `Other link: ${linkText}.\n`;
			links.push({
				target: `note_${targetIdx}`,
				range: { startOffset: start + 12, endOffset: start + 12 + linkText.length },
			});
		}
		docs.push({
			filePath,
			content,
			rawContent: content,
			parsed: {
				filePath,
				frontmatter: {},
				headings: [],
				sections: [],
				blocks: [],
				wikiLinks: links,
				tags: [],
				callouts: [],
				equations: [],
				tables: [],
			},
		});
	}

	try {
		v8.setFlagsFromString("--expose_gc");
	} catch {
		// Ignore if flags cannot be set
	}
	const runGc: () => void =
		typeof global.gc === "function"
			? global.gc
			: (vm.runInNewContext("typeof gc === 'function' ? gc : () => {}") as () => void);

	runGc();
	const initialHeapMb = process.memoryUsage().heapUsed / (1024 * 1024);

	const CYCLES = 200;
	for (let c = 0; c < CYCLES; c++) {
		buildBacklinkIndex(docs);
		computeRenameRefactor({
			oldPath: "hub/CentralHub.md",
			newPath: "knowledge/core/MasterHub.md",
			documents: docs,
		});
	}

	runGc();
	const finalHeapMb = process.memoryUsage().heapUsed / (1024 * 1024);
	const deltaMb = finalHeapMb - initialHeapMb;
	const isStable = deltaMb < 25.0; // Less than 25MB growth over 200 cycles

	console.log(`Memory Stability Results:`);
	console.log(` - Cycles: ${CYCLES}`);
	console.log(` - Initial Heap: ${initialHeapMb.toFixed(2)} MB`);
	console.log(` - Final Heap:   ${finalHeapMb.toFixed(2)} MB`);
	console.log(` - Heap Delta:    ${deltaMb.toFixed(2)} MB`);
	console.log(` - Stability:     ${isStable ? "PASS (Bounded / Stable)" : "FAIL (Unbounded Growth)"}`);

	return {
		cycles: CYCLES,
		initialHeapMb,
		finalHeapMb,
		deltaMb,
		isStable,
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN EXECUTION
// ─────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
	console.log("============================================================");
	console.log("CHALLENGER 1: EMPIRICAL STRESS TEST HARNESS — PR #17");
	console.log("Target: Milestone B Slice 4 (Deep-Links & Backlinks)");
	console.log("============================================================");

	const s1 = runDeepLinkStressTest();
	const s2 = runWikiLinkAdversarialTest();
	const s3 = runMegaVaultBenchmark();
	const s4 = runRenameCascadeStressTest();
	const s5 = runMemoryStabilityTest();

	hr("OVERALL EMPIRICAL EVALUATION VERDICT");
	console.log(`Suite 1 (Deep-Links):       PASS (${s1.passed} assertions)`);
	console.log(`Suite 2 (Wiki-Links):       ${s2.bugDetected ? "FAIL (Tier D Cross-Domain Resolution Bug)" : "PASS"}`);
	console.log(`Suite 3 (Scale Benchmark):  ${s3.meetsBudget ? "PASS" : "FAIL (buildBacklinkIndex >200ms target)"} (${s3.elapsedMs.toFixed(1)}ms for 500 docs / 5000 links)`);
	console.log(`Suite 3 (High-Degree Hub):  ${s3.hubBacklinksVerified ? "PASS (200/200 backlinks)" : "FAIL"}`);
	console.log(`Suite 4 (Rename Cascade):   ${s4.pathBugCascadeDetected ? "FAIL (Rename Corruption via Path Bug)" : "PASS"} (${s4.renamedDocsCount}/200 refactored)`);
	console.log(`Suite 5 (Memory Stability): ${s5.isStable ? "PASS" : "FAIL"} (Delta: ${s5.deltaMb.toFixed(2)} MB)`);

	const allPassed =
		s1.failed === 0 &&
		!s2.bugDetected &&
		s3.meetsBudget &&
		s3.hubBacklinksVerified &&
		!s4.pathBugCascadeDetected &&
		s5.isStable;

	console.log(`\nFinal Empirical Verdict: ${allPassed ? "APPROVE" : "REQUEST_CHANGES"}`);
	if (!allPassed) {
		console.log("\nActionable Findings for Worker B.4:");
		if (s2.bugDetected || s4.pathBugCascadeDetected) {
			console.log(" 1. Fix `resolveWikiLink`: In Tier D, guard `ciBaseMatches` with `if (!isPath)` to prevent explicit paths like `[[Physics/Quantum]]` from matching unrelated notes like `Cooking/Quantum.md` and causing rename corruption.");
		}
		if (!s3.meetsBudget) {
			console.log(` 2. Optimize buildBacklinkIndex: Elapsed time (${s3.elapsedMs.toFixed(1)}ms) exceeds <200ms target. Pre-index allPaths into normalized Map/lookup structure instead of calling availablePaths.filter with regex normalization O(L * N) times.`);
		}
	}
}

main().catch((err) => {
	console.error("Test execution failed with error:", err);
	process.exit(1);
});
