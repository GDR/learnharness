/**
 * Comprehensive Unit and Integration Tests for Obsidian Deep-Links,
 * Wiki-Link Resolution, Backlink Indexing, and Rename Refactoring.
 *
 * Verifies Milestone B Slice 4:
 * - Domain contracts & Zod schemas validation
 * - Deep-link creation (basic, folders, heading, block ref, URI encoding with Unicode/emojis)
 * - Deep-link parsing and round-tripping
 * - Deep-link error handling on empty/invalid inputs
 * - Wiki-link 4-tier resolution (relative/same-folder, exact, basename, case-insensitive, ambiguity, unresolved)
 * - Self-references ([[#Heading]], [[#^block-id]])
 * - Vault-wide backlink indexing with context snippet extraction
 * - Rename refactoring with alias, heading, and block reference preservation
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

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
} from "../src/core/index.ts";
import type {
	ObsidianDeepLinkOptions,
	WikiLinkResolution,
	BacklinkReference,
	RenameRefactorResult,
	ParsedObsidianDocument,
} from "../src/core/index.ts";

const FIXTURES_DIR = path.join(process.cwd(), "tests/fixtures/obsidian-vault");

describe("Milestone B Slice 4: Deep-Links, Wiki-Links & Backlink Resolution", () => {
	// ─── 1. Contracts & Zod Schemas ──────────────────────────────────────────

	describe("Domain Contracts & Validation Schemas", () => {
		it("validates valid ObsidianDeepLinkOptions", () => {
			const valid: ObsidianDeepLinkOptions = {
				vaultName: "KnowledgeBase",
				filePath: "Physics/Quantum.md",
				heading: "Schrödinger Equation",
				blockId: "eq1",
			};
			assert.doesNotThrow(() => validateObsidianDeepLinkOptions(valid));
		});

		it("rejects invalid ObsidianDeepLinkOptions with empty vaultName or filePath", () => {
			assert.throws(() => validateObsidianDeepLinkOptions({ vaultName: "", filePath: "Note" }));
			assert.throws(() => validateObsidianDeepLinkOptions({ vaultName: "Vault", filePath: "" }));
			assert.throws(() => validateObsidianDeepLinkOptions({}));
		});

		it("validates WikiLinkResolution schemas across all statuses", () => {
			const resolved: WikiLinkResolution = {
				target: "Quantum#Wave",
				resolvedPath: "Physics/Quantum.md",
				subpath: { type: "heading", value: "Wave" },
				status: "resolved",
			};
			assert.doesNotThrow(() => validateWikiLinkResolution(resolved));

			const ambiguous: WikiLinkResolution = {
				target: "Intro",
				status: "ambiguous",
				candidates: ["Math/Intro.md", "Physics/Intro.md"],
			};
			assert.doesNotThrow(() => validateWikiLinkResolution(ambiguous));

			const unresolved: WikiLinkResolution = {
				target: "Unknown",
				status: "unresolved",
			};
			assert.doesNotThrow(() => validateWikiLinkResolution(unresolved));
		});

		it("validates BacklinkReference schema", () => {
			const ref: BacklinkReference = {
				sourceFilePath: "Notes/Overview.md",
				targetPath: "Physics/Quantum.md",
				wikiLinkText: "[[Quantum#Wave|QM]]",
				alias: "QM",
				subpath: "Wave",
				range: { startOffset: 120, endOffset: 139 },
				contextSnippet: "Refer to the [[Quantum#Wave|QM]] chapter for details.",
			};
			assert.doesNotThrow(() => validateBacklinkReference(ref));
		});

		it("validates RenameRefactorResult schema", () => {
			const result: RenameRefactorResult = {
				filePath: "Notes/Index.md",
				originalContent: "See [[Quantum]].",
				updatedContent: "See [[QuantumMechanics]].",
				replacementsCount: 1,
			};
			assert.doesNotThrow(() => validateRenameRefactorResult(result));
			assert.throws(() =>
				validateRenameRefactorResult({
					filePath: "Notes/Index.md",
					originalContent: "...",
					updatedContent: "...",
					replacementsCount: -1,
				}),
			);
		});
	});

	// ─── 2. Deep-Link Generator ──────────────────────────────────────────────

	describe("Deep-Link Generator (createObsidianDeepLink)", () => {
		it("generates basic deep-link stripping .md extension", () => {
			const uri = createObsidianDeepLink({
				vaultName: "MyVault",
				filePath: "Notes/LinearAlgebra.md",
			});
			assert.equal(uri, "obsidian://open?vault=MyVault&file=Notes%2FLinearAlgebra");
		});

		it("strips .mdx extension and normalizes Windows backslashes", () => {
			const uri = createObsidianDeepLink({
				vaultName: "Vault",
				filePath: "Math\\Calculus\\Integration.mdx",
			});
			assert.equal(uri, "obsidian://open?vault=Vault&file=Math%2FCalculus%2FIntegration");
		});

		it("trims leading and trailing slashes from filePath", () => {
			const uri = createObsidianDeepLink({
				vaultName: "Vault",
				filePath: "/Science/Physics/Mechanics/",
			});
			assert.equal(uri, "obsidian://open?vault=Vault&file=Science%2FPhysics%2FMechanics");
		});

		it("generates deep-link with heading subpath", () => {
			const uri = createObsidianDeepLink({
				vaultName: "Personal",
				filePath: "Notes/Work.md",
				heading: "Project Tasks",
			});
			assert.equal(uri, "obsidian://open?vault=Personal&file=Notes%2FWork#Project%20Tasks");
		});

		it("generates deep-link with block reference stripping leading ^", () => {
			const uri1 = createObsidianDeepLink({
				vaultName: "Vault",
				filePath: "Theory.md",
				blockId: "^claim-123",
			});
			assert.equal(uri1, "obsidian://open?vault=Vault&file=Theory#^claim-123");

			const uri2 = createObsidianDeepLink({
				vaultName: "Vault",
				filePath: "Theory.md",
				blockId: "claim-123",
			});
			assert.equal(uri2, "obsidian://open?vault=Vault&file=Theory#^claim-123");
		});

		it("prioritizes blockId over heading if both are provided", () => {
			const uri = createObsidianDeepLink({
				vaultName: "Vault",
				filePath: "Theory.md",
				heading: "Introduction",
				blockId: "intro-block",
			});
			assert.equal(uri, "obsidian://open?vault=Vault&file=Theory#^intro-block");
		});

		it("correctly encodes spaces, Cyrillic, emojis, and math characters", () => {
			const uri = createObsidianDeepLink({
				vaultName: "База Знаний",
				filePath: "Физика/Квантовая Механика.md",
				heading: "Уравнение Шрёдингера $i\\hbar$",
			});
			assert.ok(uri.startsWith("obsidian://open?vault="));
			assert.ok(uri.includes("%D0%91%D0%B0%D0%B7%D0%B0%20%D0%97%D0%BD%D0%B0%D0%BD%D0%B8%D0%B9"));
			assert.ok(uri.includes("%D0%A4%D0%B8%D0%B7%D0%B8%D0%BA%D0%B0%2F%D0%9A%D0%B2%D0%B0%D0%BD%D1%82%D0%BE%D0%B2%D0%B0%D1%8F%20%D0%9C%D0%B5%D1%85%D0%B0%D0%BD%D0%B8%D0%BA%D0%B0"));
			assert.ok(uri.includes("#%D0%A3%D1%80%D0%B0%D0%B2%D0%BD%D0%B5%D0%BD%D0%B8%D0%B5"));

			const emojiUri = createObsidianDeepLink({
				vaultName: "Vault",
				filePath: "💡 Ideas/🚀 Launch.md",
				heading: "🌟 Milestones",
			});
			assert.ok(emojiUri.includes("%F0%9F%92%A1%20Ideas%2F%F0%9F%9A%80%20Launch"));
		});

		it("throws descriptive Error when vaultName or filePath are empty", () => {
			assert.throws(
				() => createObsidianDeepLink({ vaultName: "   ", filePath: "Doc.md" }),
				/vaultName must be a non-empty string/,
			);
			assert.throws(
				() => createObsidianDeepLink({ vaultName: "Vault", filePath: "   " }),
				/filePath must be a non-empty string/,
			);
			assert.throws(
				() => createObsidianDeepLink({ vaultName: "Vault", filePath: ".md" }),
				/filePath cannot be empty after normalization/,
			);
		});
	});

	// ─── 3. Deep-Link Parser & Round-Tripping ────────────────────────────────

	describe("Deep-Link Parser (parseObsidianDeepLink)", () => {
		it("round-trips basic deep-links", () => {
			const original: ObsidianDeepLinkOptions = {
				vaultName: "ResearchVault",
				filePath: "Science/Astronomy/Stars",
			};
			const uri = createObsidianDeepLink(original);
			const parsed = parseObsidianDeepLink(uri);
			assert.deepEqual(parsed, original);
		});

		it("round-trips links with headings", () => {
			const original: ObsidianDeepLinkOptions = {
				vaultName: "Work",
				filePath: "Weekly/Review",
				heading: "Accomplishments & Next Steps",
			};
			const uri = createObsidianDeepLink(original);
			const parsed = parseObsidianDeepLink(uri);
			assert.deepEqual(parsed, original);
		});

		it("round-trips links with block references", () => {
			const original: ObsidianDeepLinkOptions = {
				vaultName: "Papers",
				filePath: "Quantum/Schrodinger",
				blockId: "fundamental-postulate",
			};
			const uri = createObsidianDeepLink(original);
			const parsed = parseObsidianDeepLink(uri);
			assert.deepEqual(parsed, original);
		});

		it("round-trips links with Unicode characters and spaces", () => {
			const original: ObsidianDeepLinkOptions = {
				vaultName: "Мой Волт",
				filePath: "Заметки/Физика",
				heading: "Теорема Нётер",
			};
			const uri = createObsidianDeepLink(original);
			const parsed = parseObsidianDeepLink(uri);
			assert.deepEqual(parsed, original);
		});

		it("parses shorthand obsidian://vault/... URIs", () => {
			const parsed = parseObsidianDeepLink(
				"obsidian://vault/Engineering/Backend/API%20Design#Authentication",
			);
			assert.deepEqual(parsed, {
				vaultName: "Engineering",
				filePath: "Backend/API Design",
				heading: "Authentication",
			});

			const parsedBlock = parseObsidianDeepLink(
				"obsidian://vault/Personal/Journal/2026-01-01#^quote-1",
			);
			assert.deepEqual(parsedBlock, {
				vaultName: "Personal",
				filePath: "Journal/2026-01-01",
				blockId: "quote-1",
			});
		});

		it("parses heading embedded in file query parameter", () => {
			const parsed = parseObsidianDeepLink(
				"obsidian://open?vault=Vault&file=Notes%2FDoc%23EmbeddedHeading",
			);
			assert.deepEqual(parsed, {
				vaultName: "Vault",
				filePath: "Notes/Doc",
				heading: "EmbeddedHeading",
			});
		});

		it("returns null for malformed or non-obsidian URIs", () => {
			assert.equal(parseObsidianDeepLink("https://obsidian.md"), null);
			assert.equal(parseObsidianDeepLink("file:///path/to/note.md"), null);
			assert.equal(parseObsidianDeepLink("obsidian://search?query=test"), null);
			assert.equal(parseObsidianDeepLink("not-a-valid-uri"), null);
			assert.equal(parseObsidianDeepLink(""), null);
			assert.equal(parseObsidianDeepLink("obsidian://open"), null);
			assert.equal(parseObsidianDeepLink("obsidian://vault/"), null);
		});
	});

	// ─── 4. Wiki-Link Resolution ─────────────────────────────────────────────

	describe("Wiki-Link Resolution (resolveWikiLink)", () => {
		const availablePaths = [
			"Physics/Quantum/Schrodinger.md",
			"Physics/Quantum/WaveMechanics.md",
			"Physics/Classical/Newton.md",
			"Math/LinearAlgebra.md",
			"Shared/EnergyQuantizationA.md",
			"Shared/EnergyQuantizationB.md",
			"Notes/Index.md",
		];

		it("resolves Tier B: exact root-relative path", () => {
			const res = resolveWikiLink("Physics/Classical/Newton", availablePaths);
			assert.equal(res.status, "resolved");
			assert.equal(res.resolvedPath, "Physics/Classical/Newton.md");
		});

		it("resolves Tier C: bare note basename across vault", () => {
			const res = resolveWikiLink("LinearAlgebra", availablePaths);
			assert.equal(res.status, "resolved");
			assert.equal(res.resolvedPath, "Math/LinearAlgebra.md");
		});

		it("resolves Tier D: case-insensitive match", () => {
			const res = resolveWikiLink("linearalgebra", availablePaths);
			assert.equal(res.status, "resolved");
			assert.equal(res.resolvedPath, "Math/LinearAlgebra.md");

			const resPath = resolveWikiLink("physics/quantum/schrodinger", availablePaths);
			assert.equal(resPath.status, "resolved");
			assert.equal(resPath.resolvedPath, "Physics/Quantum/Schrodinger.md");
		});

		it("resolves Tier A: same folder precedence over bare basename match", () => {
			const pathsWithDuplicates = [
				"Physics/Quantum/Note.md",
				"Math/Note.md",
				"History/Note.md",
			];

			// When linking from inside Physics/Quantum, the local Note.md wins
			const resLocal = resolveWikiLink("Note", pathsWithDuplicates, "Physics/Quantum/Other.md");
			assert.equal(resLocal.status, "resolved");
			assert.equal(resLocal.resolvedPath, "Physics/Quantum/Note.md");
		});

		it("resolves relative path with ./ and ../ navigation", () => {
			const resRel = resolveWikiLink(
				"../Classical/Newton",
				availablePaths,
				"Physics/Quantum/Schrodinger.md",
			);
			assert.equal(resRel.status, "resolved");
			assert.equal(resRel.resolvedPath, "Physics/Classical/Newton.md");
		});

		it("detects ambiguous basename matches and returns candidates", () => {
			const pathsWithDuplicates = [
				"Physics/Optics/Focus.md",
				"Biology/Eye/Focus.md",
				"Photography/Camera/Focus.md",
			];

			// Linked from outside any of those folders
			const res = resolveWikiLink("Focus", pathsWithDuplicates, "General/Index.md");
			assert.equal(res.status, "ambiguous");
			assert.equal(res.candidates?.length, 3);
			assert.ok(res.candidates?.includes("Physics/Optics/Focus.md"));
		});

		it("marks non-existent targets as unresolved", () => {
			const res = resolveWikiLink("NonExistentNote", availablePaths);
			assert.equal(res.status, "unresolved");
			assert.equal(res.resolvedPath, undefined);
		});

		it("resolves subpath with heading (#Section)", () => {
			const res = resolveWikiLink(
				"Physics/Classical/Newton#Newton's Three Laws of Motion",
				availablePaths,
			);
			assert.equal(res.status, "resolved");
			assert.equal(res.resolvedPath, "Physics/Classical/Newton.md");
			assert.deepEqual(res.subpath, {
				type: "heading",
				value: "Newton's Three Laws of Motion",
			});
		});

		it("resolves subpath with block reference (#^block-id)", () => {
			const res = resolveWikiLink("Schrodinger#^eq1", availablePaths);
			assert.equal(res.status, "resolved");
			assert.equal(res.resolvedPath, "Physics/Quantum/Schrodinger.md");
			assert.deepEqual(res.subpath, {
				type: "block",
				value: "eq1",
			});
		});

		it("resolves self-referential links within current document", () => {
			const resHeading = resolveWikiLink(
				"#Fundamental Postulate",
				availablePaths,
				"Physics/Quantum/Schrodinger.md",
			);
			assert.equal(resHeading.status, "resolved");
			assert.equal(resHeading.resolvedPath, "Physics/Quantum/Schrodinger.md");
			assert.deepEqual(resHeading.subpath, {
				type: "heading",
				value: "Fundamental Postulate",
			});

			const resBlock = resolveWikiLink(
				"#^eq1",
				availablePaths,
				"Physics/Quantum/Schrodinger.md",
			);
			assert.equal(resBlock.status, "resolved");
			assert.equal(resBlock.resolvedPath, "Physics/Quantum/Schrodinger.md");
			assert.deepEqual(resBlock.subpath, {
				type: "block",
				value: "eq1",
			});
		});

		it("handles wikilink bracket syntax [[Target|Alias]] gracefully", () => {
			const res = resolveWikiLink("[[Physics/Classical/Newton|Newtonian Law]]", availablePaths);
			assert.equal(res.status, "resolved");
			assert.equal(res.resolvedPath, "Physics/Classical/Newton.md");
		});
	});

	// ─── 5. Backlink Indexing ────────────────────────────────────────────────

	describe("Backlink Indexing (buildBacklinkIndex)", () => {
		it("indexes cross-references across fixture notes in obsidian-vault", () => {
			const files = [
				"Physics/Quantum/Schrodinger.md",
				"Physics/Classical/Newton.md",
				"Physics/Quantum/WaveMechanics.md",
				"Math/LinearAlgebra.md",
			];

			const documents = files.map((rel) => {
				const full = path.join(FIXTURES_DIR, rel);
				const content = fs.readFileSync(full, "utf-8");
				return {
					filePath: rel,
					parsed: parseObsidianMarkdown(content, rel),
					rawContent: content,
				};
			});

			const index = buildBacklinkIndex(documents);

			// Newton.md links to Schrodinger.md: [[Physics/Quantum/Schrodinger|quantum wave mechanics]]
			const schrodingerBacklinks = index.get("Physics/Quantum/Schrodinger.md");
			assert.ok(schrodingerBacklinks && schrodingerBacklinks.length > 0);
			const refFromNewton = schrodingerBacklinks.find(
				(r) => r.sourceFilePath === "Physics/Classical/Newton.md",
			);
			assert.ok(refFromNewton);
			assert.equal(refFromNewton.alias, "quantum wave mechanics");
			assert.ok(refFromNewton.contextSnippet.includes("classical mechanics is superseded"));

			// Schrodinger.md links to Newton.md: [[Physics/Classical/Newton|Newtonian mechanics]]
			const newtonBacklinks = index.get("Physics/Classical/Newton.md");
			assert.ok(newtonBacklinks && newtonBacklinks.length > 0);
			const refFromSchrodinger = newtonBacklinks.find(
				(r) => r.sourceFilePath === "Physics/Quantum/Schrodinger.md",
			);
			assert.ok(refFromSchrodinger);
			assert.equal(refFromSchrodinger.alias, "Newtonian mechanics");

			// Schrodinger.md links to LinearAlgebra: [[LinearAlgebra|state space]]
			const laBacklinks = index.get("Math/LinearAlgebra.md");
			assert.ok(laBacklinks && laBacklinks.length > 0);
			const laRef = laBacklinks.find(
				(r) => r.sourceFilePath === "Physics/Quantum/Schrodinger.md",
			);
			assert.ok(laRef);
			assert.equal(laRef.alias, "state space");
		});

		it("captures snippet around link when lines are long (>200 chars)", () => {
			const longLine =
				"Preamble " +
				"a".repeat(120) +
				" [[TargetNote#Section|MyTarget]] " +
				"b".repeat(120) +
				" Postscript";

			const doc = {
				filePath: "Source.md",
				content: longLine,
				parsed: parseObsidianMarkdown(longLine, "Source.md"),
			};

			const targetDoc = {
				filePath: "TargetNote.md",
				content: "# Target Note",
				parsed: parseObsidianMarkdown("# Target Note", "TargetNote.md"),
			};

			const index = buildBacklinkIndex([
				{ filePath: doc.filePath, parsed: doc.parsed, rawContent: doc.content },
				{ filePath: targetDoc.filePath, parsed: targetDoc.parsed, rawContent: targetDoc.content },
			]);

			const backlinks = index.get("TargetNote.md");
			assert.ok(backlinks && backlinks.length === 1 && backlinks[0]);
			const firstBacklink = backlinks[0];
			assert.equal(firstBacklink.alias, "MyTarget");
			assert.equal(firstBacklink.subpath, "Section");
			assert.ok(firstBacklink.contextSnippet.includes("[[TargetNote#Section|MyTarget]]"));
		});

		it("truncates with ellipsis when single line is extraordinarily long (>500 chars)", () => {
			const veryLongLine =
				"Start: " +
				"x".repeat(400) +
				" [[TargetNote]] " +
				"y".repeat(400) +
				" :End";

			const doc = {
				filePath: "SourceLong.md",
				content: veryLongLine,
				parsed: parseObsidianMarkdown(veryLongLine, "SourceLong.md"),
			};
			const targetDoc = {
				filePath: "TargetNote.md",
				content: "# Target",
				parsed: parseObsidianMarkdown("# Target", "TargetNote.md"),
			};

			const index = buildBacklinkIndex([
				{ filePath: doc.filePath, parsed: doc.parsed, rawContent: doc.content },
				{ filePath: targetDoc.filePath, parsed: targetDoc.parsed, rawContent: targetDoc.content },
			]);

			const backlinks = index.get("TargetNote.md");
			assert.ok(backlinks && backlinks.length === 1 && backlinks[0]);
			const firstBacklink = backlinks[0];
			assert.ok(firstBacklink.contextSnippet.startsWith("..."));
			assert.ok(firstBacklink.contextSnippet.endsWith("..."));
			assert.ok(firstBacklink.contextSnippet.includes("[[TargetNote]]"));
		});

		it("returns empty map on empty document list", () => {
			const index = buildBacklinkIndex([]);
			assert.equal(index.size, 0);
		});
	});

	// ─── 6. Rename Refactoring ───────────────────────────────────────────────

	describe("Rename Refactoring (computeRenameRefactor)", () => {
		it("refactors references across multiple documents when a note is renamed", () => {
			const doc1Content =
				"In this study, we rely on [[Physics/Quantum/Schrodinger|quantum wave mechanics]] and [[Newton]].";
			const doc2Content =
				"The equation was derived by [[Schrodinger#The Time-Dependent Schrödinger Equation|Erwin]].";
			const doc3Content =
				"No references to the target here, only [[LinearAlgebra]].";

			const documents = [
				{
					filePath: "Notes/Review1.md",
					content: doc1Content,
					parsed: parseObsidianMarkdown(doc1Content, "Notes/Review1.md"),
				},
				{
					filePath: "Notes/Review2.md",
					content: doc2Content,
					parsed: parseObsidianMarkdown(doc2Content, "Notes/Review2.md"),
				},
				{
					filePath: "Notes/Review3.md",
					content: doc3Content,
					parsed: parseObsidianMarkdown(doc3Content, "Notes/Review3.md"),
				},
				{
					filePath: "Physics/Quantum/Schrodinger.md",
					content: "# Schrödinger",
					parsed: parseObsidianMarkdown("# Schrödinger", "Physics/Quantum/Schrodinger.md"),
				},
				{
					filePath: "Physics/Classical/Newton.md",
					content: "# Newton",
					parsed: parseObsidianMarkdown("# Newton", "Physics/Classical/Newton.md"),
				},
			];

			const results = computeRenameRefactor({
				oldPath: "Physics/Quantum/Schrodinger.md",
				newPath: "Science/Physics/ErwinSchrodinger.md",
				documents,
			});

			assert.equal(results.length, 2);

			const r1 = results.find((r) => r.filePath === "Notes/Review1.md");
			assert.ok(r1);
			assert.equal(r1.replacementsCount, 1);
			// Path target preserved with updated path and preserved alias
			assert.equal(
				r1.updatedContent,
				"In this study, we rely on [[Science/Physics/ErwinSchrodinger|quantum wave mechanics]] and [[Newton]].",
			);

			const r2 = results.find((r) => r.filePath === "Notes/Review2.md");
			assert.ok(r2);
			assert.equal(r2.replacementsCount, 1);
			// Bare target updated to new basename with preserved subpath and alias
			assert.equal(
				r2.updatedContent,
				"The equation was derived by [[ErwinSchrodinger#The Time-Dependent Schrödinger Equation|Erwin]].",
			);

			// Review3 had no references to oldPath
			assert.ok(!results.some((r) => r.filePath === "Notes/Review3.md"));
		});

		it("preserves block references during rename refactoring", () => {
			const content = "Fundamental relation: [[Quantum#^eq1|Schrödinger equation]].";
			const documents = [
				{
					filePath: "Notes/Paper.md",
					content,
					parsed: parseObsidianMarkdown(content, "Notes/Paper.md"),
				},
				{
					filePath: "Physics/Quantum.md",
					content: "# Quantum",
					parsed: parseObsidianMarkdown("# Quantum", "Physics/Quantum.md"),
				},
			];

			const results = computeRenameRefactor({
				oldPath: "Physics/Quantum.md",
				newPath: "Physics/QuantumMechanics.md",
				documents,
			});

			assert.equal(results.length, 1);
			const [firstResult] = results;
			assert.ok(firstResult);
			assert.equal(
				firstResult.updatedContent,
				"Fundamental relation: [[QuantumMechanics#^eq1|Schrödinger equation]].",
			);
		});

		it("handles multiple links to the renamed note in the same document", () => {
			const content =
				"Start with [[Quantum]] first. Then inspect [[Quantum#Wave|Wave section]] and [[Quantum#^eq1]].";
			const documents = [
				{
					filePath: "Notes/Syllabus.md",
					content,
					parsed: parseObsidianMarkdown(content, "Notes/Syllabus.md"),
				},
				{
					filePath: "Quantum.md",
					content: "# Quantum",
					parsed: parseObsidianMarkdown("# Quantum", "Quantum.md"),
				},
			];

			const results = computeRenameRefactor({
				oldPath: "Quantum.md",
				newPath: "QuantumPhysics.md",
				documents,
			});

			assert.equal(results.length, 1);
			const [firstResult] = results;
			assert.ok(firstResult);
			assert.equal(firstResult.replacementsCount, 3);
			assert.equal(
				firstResult.updatedContent,
				"Start with [[QuantumPhysics]] first. Then inspect [[QuantumPhysics#Wave|Wave section]] and [[QuantumPhysics#^eq1]].",
			);
		});

		it("disambiguates to full path if the new basename is ambiguous", () => {
			const content = "Refer to [[Optics]].";
			const documents = [
				{
					filePath: "Notes/Guide.md",
					content,
					parsed: parseObsidianMarkdown(content, "Notes/Guide.md"),
				},
				{
					filePath: "Physics/Optics.md",
					content: "# Optics",
					parsed: parseObsidianMarkdown("# Optics", "Physics/Optics.md"),
				},
				{
					filePath: "Biology/Focus.md",
					content: "# Focus",
					parsed: parseObsidianMarkdown("# Focus", "Biology/Focus.md"),
				},
			];

			// Renaming Physics/Optics.md to Physics/Focus.md (which clashes with Biology/Focus.md)
			const results = computeRenameRefactor({
				oldPath: "Physics/Optics.md",
				newPath: "Physics/Focus.md",
				documents,
			});

			assert.equal(results.length, 1);
			const [firstResult] = results;
			assert.ok(firstResult);
			// Because "Focus" is ambiguous between Physics/Focus and Biology/Focus from Notes/Guide.md,
			// it should use the disambiguated path Physics/Focus
			assert.equal(firstResult.updatedContent, "Refer to [[Physics/Focus]].");
		});

		it("returns empty results when oldPath equals newPath", () => {
			const content = "Link to [[Doc]].";
			const documents = [
				{
					filePath: "Notes/A.md",
					content,
					parsed: parseObsidianMarkdown(content, "Notes/A.md"),
				},
			];
			const results = computeRenameRefactor({
				oldPath: "Doc.md",
				newPath: "Doc.md",
				documents,
			});
			assert.equal(results.length, 0);
		});
	});
});
