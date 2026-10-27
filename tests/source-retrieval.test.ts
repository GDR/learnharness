/**
 * Comprehensive Test Suite for Milestone D Slice 2 (Source-Aware Retrieval & Ranking).
 *
 * Covers:
 * - Suite 1: Contracts & Tokenization (Zod schemas, tokenization, stop-words, computeLineRange, highlights).
 * - Suite 2: BM25 Scoring & Structural Heading Boosts (monotonicity, heading/ancestor/path/exact phrase/grounding boosts).
 * - Suite 3: Exact Citation Assembly & Deep-Links (line numbers, character ranges, obsidian:// URIs).
 * - Suite 4: StudyScope Filter Confinement & Cross-Project Isolation (project, source, doc, tag, proposition, syntax filters, disconnected vault).
 * - Suite 5: Performance & Scale SLA (<15ms local, <50ms CI across 1,000 sections).
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	validateRetrievalQuery,
	InvalidRetrievalQueryError,
	DEFAULT_TOP_K,
	DEFAULT_MIN_SCORE,
	type CandidateSection,
	SectionRanker,
	retrieveSections,
	retrieveProjectSections,
	computeLineRange,
	tokenizeText,
	filterQueryTokens,
	generateMatchHighlights,
	calculateRobertsonSpärckJonesIdf,
	STOP_WORDS,
	DocumentNotFoundError,
	ScopeResolutionError,
	createSourceStore,
} from "../src/server/index.ts";
import {
	SourceNotFoundError,
	type ProjectContext,
	type Vault,
} from "../src/core/contracts/project.ts";
import type { VaultRegistry } from "../src/core/ports.ts";

const FIXTURES_VAULT_PATH = path.resolve("tests/fixtures/obsidian-vault");

// ─── Suite 1: Contracts & Tokenization ───────────────────────────────────────

describe("Suite 1: Contracts & Tokenization", () => {
	it("validates valid retrieval queries with defaults", () => {
		const q = validateRetrievalQuery({ query: "Schrödinger wave mechanics" });
		assert.equal(q.query, "Schrödinger wave mechanics");
		assert.equal(q.topK, DEFAULT_TOP_K);
		assert.equal(q.minScore, DEFAULT_MIN_SCORE);
		assert.equal(q.scope, undefined);
		assert.equal(q.syntaxFilters, undefined);
	});

	it("validates custom topK, minScore, and syntaxFilters", () => {
		const q = validateRetrievalQuery({
			query: "Hamiltonian operator",
			topK: 10,
			minScore: 0.5,
			syntaxFilters: { hasEquation: true },
		});
		assert.equal(q.topK, 10);
		assert.equal(q.minScore, 0.5);
		assert.deepEqual(q.syntaxFilters, { hasEquation: true });
	});

	it("rejects empty or whitespace-only queries with InvalidRetrievalQueryError (status 400)", () => {
		assert.throws(() => validateRetrievalQuery({ query: "" }), (err: unknown) => {
			return err instanceof InvalidRetrievalQueryError && err.status === 400;
		});

		assert.throws(() => validateRetrievalQuery({ query: "   " }), (err: unknown) => {
			return err instanceof InvalidRetrievalQueryError && err.status === 400;
		});

		assert.throws(() => validateRetrievalQuery(null), (err: unknown) => {
			return err instanceof InvalidRetrievalQueryError && err.status === 400;
		});
	});

	it("enforces topK bounds (1 <= topK <= 20)", () => {
		assert.throws(() => validateRetrievalQuery({ query: "valid", topK: 0 }), InvalidRetrievalQueryError);
		assert.throws(() => validateRetrievalQuery({ query: "valid", topK: 25 }), InvalidRetrievalQueryError);
	});

	it("tokenizes Unicode letters, Cyrillic, Greek, and hyphenated terms correctly", () => {
		const text = "Erwin Schrödinger: волновая механика и α-частицы with time-dependent wave-function!";
		const tokens = tokenizeText(text);
		assert.ok(tokens.includes("erwin"));
		assert.ok(tokens.includes("schrödinger"));
		assert.ok(tokens.includes("волновая"));
		assert.ok(tokens.includes("механика"));
		assert.ok(tokens.includes("α-частицы"));
		assert.ok(tokens.includes("time-dependent"));
		assert.ok(tokens.includes("wave-function"));
		assert.ok(!tokens.includes(":"));
		assert.ok(!tokens.includes("!"));
	});

	it("filters stop words but retains tokens when query consists solely of stop words", () => {
		const mixed = filterQueryTokens(tokenizeText("the equation of wave and mechanics в квантовой"));
		assert.deepEqual(mixed, ["equation", "wave", "mechanics", "квантовой"]);

		const allStops = filterQueryTokens(tokenizeText("to be or not to be"));
		assert.deepEqual(allStops, ["to", "be", "or", "not", "to", "be"]);
	});

	it("computes exact 1-indexed line numbers from character offsets", () => {
		const doc = "Line 1\nLine 2 is longer\nLine 3\nLine 4\n";
		// Line 1: 0..6, \n at 6
		// Line 2: 7..23, \n at 23
		// Line 3: 24..30, \n at 30
		// Line 4: 31..37, \n at 37

		// Empty doc
		assert.deepEqual(computeLineRange("", { startOffset: 0, endOffset: 0 }), { start: 1, end: 1 });

		// Line 1 slice
		assert.deepEqual(computeLineRange(doc, { startOffset: 0, endOffset: 6 }), { start: 1, end: 1 });

		// Line 1 with trailing newline terminating the line belongs to line 1
		assert.deepEqual(computeLineRange(doc, { startOffset: 0, endOffset: 7 }), { start: 1, end: 1 });

		// Spanning Line 1 to Line 2
		assert.deepEqual(computeLineRange(doc, { startOffset: 0, endOffset: 12 }), { start: 1, end: 2 });

		// Strictly Line 2
		assert.deepEqual(computeLineRange(doc, { startOffset: 7, endOffset: 24 }), { start: 2, end: 2 });

		// Spanning Line 2 to Line 4
		assert.deepEqual(computeLineRange(doc, { startOffset: 7, endOffset: 35 }), { start: 2, end: 4 });
	});

	it("generates contextual match highlights with term bolding", () => {
		const content = "The Schrödinger equation describes the wave function of a quantum system. Classical mechanics does not apply.";
		const highlights = generateMatchHighlights(content, ["schrödinger", "equation"]);
		assert.ok(highlights.length > 0);
		assert.ok(highlights[0]!.includes("**Schrödinger**") || highlights[0]!.includes("**schrödinger**"));
		assert.ok(highlights[0]!.includes("**equation**"));
	});
});

// ─── Suite 2: BM25 Scoring & Structural Heading Boosts ──────────────────────

describe("Suite 2: BM25 Scoring & Structural Heading Boosts", () => {
	const baseCitation = {
		sourceId: "src_test",
		vaultId: "vault_test",
		vaultName: "TestVault",
		documentPath: "Notes/Physics.md",
		headingHierarchy: ["Physics"],
		lineRange: { start: 1, end: 5 },
		characterRange: { startOffset: 0, endOffset: 100 },
		deepLink: "obsidian://open?vault=TestVault&file=Notes/Physics.md",
	};

	it("rewards higher term frequency monotonically", () => {
		const candidates: CandidateSection[] = [
			{
				id: "sec_low_tf",
				content: "The quantum state evolves according to wave mechanics.",
				headingHierarchy: [],
				documentPath: "Note1.md",
				tokenEstimate: 10,
				citation: baseCitation,
			},
			{
				id: "sec_high_tf",
				content: "Quantum quantum quantum state evolves in quantum wave mechanics.",
				headingHierarchy: [],
				documentPath: "Note2.md",
				tokenEstimate: 10,
				citation: baseCitation,
			},
		];

		const ranker = new SectionRanker();
		const results = ranker.rank(candidates, "quantum", 2);
		assert.equal(results.length, 2);
		assert.equal(results[0]!.sectionId, "sec_high_tf");
		assert.ok(results[0]!.score > results[1]!.score, "Higher TF should result in higher BM25 score");
	});

	it("applies structural heading boost (2.5x) over body-only matches", () => {
		const candidates: CandidateSection[] = [
			{
				id: "sec_body_only",
				content: "This section explores the Schrödinger wave equation in depth.",
				heading: "Overview",
				headingHierarchy: ["Overview"],
				documentPath: "Doc1.md",
				tokenEstimate: 15,
				citation: baseCitation,
			},
			{
				id: "sec_heading_match",
				content: "This section explores the fundamentals in depth.",
				heading: "Schrödinger Equation",
				headingHierarchy: ["Schrödinger Equation"],
				documentPath: "Doc2.md",
				tokenEstimate: 15,
				citation: baseCitation,
			},
		];

		const ranker = new SectionRanker();
		const results = ranker.rank(candidates, "Schrödinger", 2);
		assert.equal(results.length, 2);
		assert.equal(results[0]!.sectionId, "sec_heading_match", "Direct heading match must outrank body match");
		assert.ok(results[0]!.score > results[1]!.score * 1.5);
	});

	it("applies ancestor heading hierarchy boost (1.5x)", () => {
		const candidates: CandidateSection[] = [
			{
				id: "sec_with_ancestor",
				content: "Discussion of normalization and state spaces.",
				headingHierarchy: ["Quantum Mechanics", "Wave Theory"],
				documentPath: "NoteA.md",
				tokenEstimate: 10,
				citation: baseCitation,
			},
			{
				id: "sec_no_ancestor",
				content: "Discussion of normalization and state spaces.",
				headingHierarchy: ["Classical Theory", "Statics"],
				documentPath: "NoteB.md",
				tokenEstimate: 10,
				citation: baseCitation,
			},
		];

		const ranker = new SectionRanker();
		const results = ranker.rank(candidates, "Quantum", 2);
		assert.equal(results.length, 1);
		assert.equal(results[0]!.sectionId, "sec_with_ancestor");
	});

	it("applies document path boost (1.8x)", () => {
		const candidates: CandidateSection[] = [
			{
				id: "sec_matching_path",
				content: "Fundamental concepts of vectors and transformations.",
				headingHierarchy: [],
				documentPath: "Math/LinearAlgebra.md",
				tokenEstimate: 10,
				citation: baseCitation,
			},
			{
				id: "sec_other_path",
				content: "Fundamental concepts of vectors and transformations.",
				headingHierarchy: [],
				documentPath: "General/Notes.md",
				tokenEstimate: 10,
				citation: baseCitation,
			},
		];

		const ranker = new SectionRanker();
		const results = ranker.rank(candidates, "LinearAlgebra", 2);
		assert.equal(results.length, 1);
		assert.equal(results[0]!.sectionId, "sec_matching_path");
	});

	it("applies exact phrase boost and proposition grounding multiplier", () => {
		const candidates: CandidateSection[] = [
			{
				id: "sec_individual_words",
				content: "The time of arrival is dependent on the Schrödinger formulation.",
				headingHierarchy: [],
				documentPath: "Note1.md",
				tokenEstimate: 15,
				citation: baseCitation,
			},
			{
				id: "sec_exact_phrase_body",
				content: "We solve the time-dependent Schrödinger formulation analytically.",
				headingHierarchy: [],
				documentPath: "Note2.md",
				tokenEstimate: 15,
				citation: baseCitation,
			},
			{
				id: "sec_grounded_evidence",
				content: "We solve the time-dependent Schrödinger formulation analytically.",
				headingHierarchy: [],
				documentPath: "Note3.md",
				tokenEstimate: 15,
				citation: baseCitation,
				isEvidenceGrounding: true,
			},
		];

		const ranker = new SectionRanker();
		const results = ranker.rank(candidates, "time-dependent Schrödinger", 3);
		assert.equal(results.length, 3);
		// Candidate with exact phrase + grounding boost should be #1
		assert.equal(results[0]!.sectionId, "sec_grounded_evidence");
		// Candidate with exact phrase body boost should be #2
		assert.equal(results[1]!.sectionId, "sec_exact_phrase_body");
		assert.ok(results[1]!.score > results[2]!.score);
	});
});

// ─── Suite 3: Exact Citation Assembly & Deep-Links ──────────────────────────

describe("Suite 3: Exact Citation Assembly & Obsidian Deep-Links", () => {
	let testTmpDir: string;
	let sourcesDir: string;
	let mockRegistry: VaultRegistry;
	let context: ProjectContext;

	beforeEach(async () => {
		testTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-retrieval-suite3-"));
		sourcesDir = path.join(testTmpDir, "sources");

		const sourceStore = createSourceStore(sourcesDir);
		const source = await sourceStore.addSource({
			projectId: "proj_physics",
			vaultId: "vault_main",
			id: "src_physics_1",
		});

		await sourceStore.upsertDocument({
			id: "doc_schrodinger",
			projectId: "proj_physics",
			sourceId: source.id,
			vaultId: "vault_main",
			currentPath: "Physics/Quantum/Schrodinger.md",
			contentHash: "hash_schrodinger_v1",
			revisionId: "rev_schrodinger_1",
			status: "active",
		});

		const mockVault: Vault = {
			id: "vault_main",
			displayName: "Physics Research Vault",
			kind: "obsidian",
			bindings: [
				{
					deviceId: "dev_mac",
					rootPath: FIXTURES_VAULT_PATH,
					status: "available",
				},
			],
		};

		mockRegistry = {
			getVault: async (id: string) => (id === "vault_main" ? mockVault : null),
			listVaults: async () => [mockVault],
			registerVault: async () => mockVault,
			updateVault: async () => mockVault,
			deleteVault: async () => true,
		} as unknown as VaultRegistry;

		context = {
			projectId: "proj_physics",
			sources: sourceStore,
			chats: {} as any,
			graph: {} as any,
			jobs: {} as any,
			practice: {} as any,
		};
	});

	afterEach(() => {
		try {
			fs.rmSync(testTmpDir, { recursive: true, force: true });
		} catch {}
	});

	it("assembles complete source citations with exact 1-indexed line numbers and Obsidian deep-links", async () => {
		const result = await retrieveSections(
			context,
			{ query: "Hamiltonian operator time-dependent", topK: 5 },
			{ vaultRegistry: mockRegistry },
		);

		assert.ok(result.sections.length > 0, "Must retrieve sections from Schrodinger.md");
		const sec = result.sections[0]!;

		// Check citation structure
		const cit = sec.citation;
		assert.equal(cit.sourceId, "src_physics_1");
		assert.equal(cit.vaultId, "vault_main");
		assert.equal(cit.vaultName, "Physics Research Vault");
		assert.equal(cit.documentId, "doc_schrodinger");
		assert.equal(cit.documentPath, "Physics/Quantum/Schrodinger.md");
		assert.equal(cit.revisionId, "rev_schrodinger_1");
		assert.equal(cit.contentHash, "hash_schrodinger_v1");

		// Check line numbers
		assert.ok(cit.lineRange.start >= 1, "start line must be >= 1");
		assert.ok(cit.lineRange.end >= cit.lineRange.start, "end line must be >= start line");

		// Check deepLink format: obsidian://open?vault=...&file=...
		assert.ok(cit.deepLink.startsWith("obsidian://open?vault="));
		assert.ok(cit.deepLink.includes("file=Physics%2FQuantum%2FSchrodinger"));

		// When block ID is present (^eq1 on the time-dependent section), deepLink targets the block
		if (sec.blockIds?.includes("eq1")) {
			assert.ok(cit.deepLink.includes("%23%5Eeq1") || cit.deepLink.includes("#^eq1"), "Deep link must target block ID");
		}
	});
});

// ─── Suite 4: StudyScope Filter Confinement & Cross-Project Isolation ───────

describe("Suite 4: StudyScope Filter Confinement & Cross-Project Isolation", () => {
	let testTmpDir: string;
	let sourcesDirA: string;
	let sourcesDirB: string;
	let mockRegistry: VaultRegistry;
	let contextA: ProjectContext;
	let contextB: ProjectContext;

	beforeEach(async () => {
		testTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-retrieval-suite4-"));
		sourcesDirA = path.join(testTmpDir, "sources_a");
		sourcesDirB = path.join(testTmpDir, "sources_b");

		const storeA = createSourceStore(sourcesDirA);
		const storeB = createSourceStore(sourcesDirB);

		// Project A sources
		const srcA1 = await storeA.addSource({
			projectId: "proj_a",
			vaultId: "vault_shared",
			id: "src_quantum",
		});
		const srcA2 = await storeA.addSource({
			projectId: "proj_a",
			vaultId: "vault_shared",
			id: "src_classical",
		});

		await storeA.upsertDocument({
			id: "doc_schrodinger",
			projectId: "proj_a",
			sourceId: srcA1.id,
			vaultId: "vault_shared",
			currentPath: "Physics/Quantum/Schrodinger.md",
			contentHash: "hash_s",
			revisionId: "rev_s",
			status: "active",
		});

		await storeA.upsertDocument({
			id: "doc_newton",
			projectId: "proj_a",
			sourceId: srcA2.id,
			vaultId: "vault_shared",
			currentPath: "Physics/Classical/Newton.md",
			contentHash: "hash_n",
			revisionId: "rev_n",
			status: "active",
		});

		await storeA.upsertDocument({
			id: "doc_linear_algebra",
			projectId: "proj_a",
			sourceId: srcA1.id,
			vaultId: "vault_shared",
			currentPath: "Math/LinearAlgebra.md",
			contentHash: "hash_la",
			revisionId: "rev_la",
			status: "active",
		});

		// Project B sources
		const srcB1 = await storeB.addSource({
			projectId: "proj_b",
			vaultId: "vault_shared",
			id: "src_b_secret",
		});
		await storeB.upsertDocument({
			id: "doc_b_private",
			projectId: "proj_b",
			sourceId: srcB1.id,
			vaultId: "vault_shared",
			currentPath: "Notes/MovedNote.md",
			contentHash: "hash_b",
			revisionId: "rev_b",
			status: "active",
		});

		const mockVault: Vault = {
			id: "vault_shared",
			displayName: "Test Vault",
			kind: "obsidian",
			bindings: [
				{
					deviceId: "dev_local",
					rootPath: FIXTURES_VAULT_PATH,
					status: "available",
				},
			],
		};

		const mockUnavailableVault: Vault = {
			id: "vault_disconnected",
			displayName: "Unavailable Vault",
			kind: "obsidian",
			bindings: [
				{
					deviceId: "dev_remote",
					rootPath: "/nonexistent/remote/vault",
					status: "unavailable",
				},
			],
		};

		mockRegistry = {
			getVault: async (id: string) => {
				if (id === "vault_shared") return mockVault;
				if (id === "vault_disconnected") return mockUnavailableVault;
				return null;
			},
			listVaults: async () => [mockVault, mockUnavailableVault],
		} as unknown as VaultRegistry;

		// Mock graph with proposition evidence & chains for Project A
		const evidenceList = [
			{
				id: "ev_1",
				propositionId: "prop_wave_equation",
				sourceId: "src_quantum",
				documentId: "doc_schrodinger",
				heading: "The Time-Dependent Schrödinger Equation",
				status: "active",
			},
			{
				id: "ev_2",
				propositionId: "prop_linear_spaces",
				sourceId: "src_quantum",
				documentId: "doc_linear_algebra",
				heading: "Vector Spaces and Inner Products",
				status: "active",
			},
		];

		const mockGraph = {
			getEvidenceForProposition: async (propId: string) => {
				return evidenceList.filter((e) => e.propositionId === propId);
			},
			readChains: () => [
				{
					id: "chain_1",
					premises: ["prop_linear_spaces"],
					conclusion: "prop_wave_equation",
					provenance: [],
					createdAt: "2026-01-01",
				},
			],
		};

		contextA = {
			projectId: "proj_a",
			sources: storeA,
			chats: {} as any,
			graph: mockGraph as any,
			jobs: {} as any,
			practice: {} as any,
		};

		contextB = {
			projectId: "proj_b",
			sources: storeB,
			chats: {} as any,
			graph: { getEvidenceForProposition: async () => [], readChains: () => [] } as any,
			jobs: {} as any,
			practice: {} as any,
		};
	});

	afterEach(() => {
		try {
			fs.rmSync(testTmpDir, { recursive: true, force: true });
		} catch {}
	});

	it("retrieves across all active sources under default project scope", async () => {
		const res = await retrieveSections(
			contextA,
			{ query: "mechanics" },
			{ vaultRegistry: mockRegistry },
		);
		assert.ok(res.sections.length > 0);
		const docPaths = new Set(res.sections.map((s) => s.citation.documentPath));
		// Both Schrodinger (src_quantum) and Newton (src_classical) contain 'mechanics'
		assert.ok(docPaths.has("Physics/Quantum/Schrodinger.md"));
		assert.ok(docPaths.has("Physics/Classical/Newton.md"));
	});

	it("strictly confines results to specified source in source scope", async () => {
		const res = await retrieveSections(
			contextA,
			{
				query: "mechanics",
				scope: { type: "source", sourceIds: ["src_classical"] },
			},
			{ vaultRegistry: mockRegistry },
		);

		assert.ok(res.sections.length > 0);
		for (const sec of res.sections) {
			assert.equal(sec.citation.sourceId, "src_classical");
			assert.equal(sec.citation.documentPath, "Physics/Classical/Newton.md");
		}
	});

	it("fails fast with SourceNotFoundError (404) when querying foreign or non-existent sourceId", async () => {
		await assert.rejects(
			async () => {
				await retrieveSections(
					contextA,
					{
						query: "mechanics",
						scope: { type: "source", sourceIds: ["src_b_secret"] },
					},
					{ vaultRegistry: mockRegistry },
				);
			},
			(err: unknown) => {
				return err instanceof SourceNotFoundError && err.status === 404;
			},
		);
	});

	it("strictly confines results to specified document in document scope", async () => {
		const res = await retrieveSections(
			contextA,
			{
				query: "mechanics",
				scope: { type: "document", documentIds: ["doc_schrodinger"] },
			},
			{ vaultRegistry: mockRegistry },
		);

		assert.ok(res.sections.length > 0);
		for (const sec of res.sections) {
			assert.equal(sec.citation.documentId, "doc_schrodinger");
		}
	});

	it("fails fast with DocumentNotFoundError (404) when querying foreign or non-existent documentId", async () => {
		await assert.rejects(
			async () => {
				await retrieveSections(
					contextA,
					{
						query: "mechanics",
						scope: { type: "document", documentIds: ["doc_b_private"] },
					},
					{ vaultRegistry: mockRegistry },
				);
			},
			(err: unknown) => {
				return err instanceof DocumentNotFoundError && err.status === 404;
			},
		);
	});

	it("confines results to documents containing matching tags in tag scope", async () => {
		const res = await retrieveSections(
			contextA,
			{
				query: "equation",
				scope: { type: "tag", tagNames: ["#quantum"] },
			},
			{ vaultRegistry: mockRegistry },
		);

		assert.ok(res.sections.length > 0);
		for (const sec of res.sections) {
			assert.equal(sec.citation.documentPath, "Physics/Quantum/Schrodinger.md");
		}
	});

	it("filters by syntax filters (hasTable and hasEquation)", async () => {
		const resTable = await retrieveSections(
			contextA,
			{
				query: "law",
				syntaxFilters: { hasTable: true },
			},
			{ vaultRegistry: mockRegistry },
		);

		assert.ok(resTable.sections.length > 0);
		for (const sec of resTable.sections) {
			assert.equal(sec.hasTable, true);
		}

		const resEq = await retrieveSections(
			contextA,
			{
				query: "wave",
				syntaxFilters: { hasEquation: true },
			},
			{ vaultRegistry: mockRegistry },
		);

		assert.ok(resEq.sections.length > 0);
		for (const sec of resEq.sections) {
			assert.equal(sec.hasEquation, true);
		}
	});

	it("traverses knowledge graph chains when includePrerequisites is true in proposition scope", async () => {
		// prop_wave_equation has evidence in Schrodinger.md
		// chain: prop_linear_spaces -> prop_wave_equation
		// prop_linear_spaces has evidence in LinearAlgebra.md
		const resPrereq = await retrieveSections(
			contextA,
			{
				query: "space",
				scope: {
					type: "proposition",
					propositionIds: ["prop_wave_equation"],
					includePrerequisites: true,
				},
			},
			{ vaultRegistry: mockRegistry },
		);

		assert.ok(resPrereq.sections.length > 0);
		const docPaths = new Set(resPrereq.sections.map((s) => s.citation.documentPath));
		assert.ok(docPaths.has("Math/LinearAlgebra.md"), "Prerequisite chain must include LinearAlgebra.md");
	});

	it("rejects mismatched projectId in scope with ScopeResolutionError (400)", async () => {
		await assert.rejects(
			async () => {
				await retrieveSections(
					contextA,
					{
						query: "mechanics",
						scope: { type: "project", projectId: "proj_b" },
					},
					{ vaultRegistry: mockRegistry },
				);
			},
			(err: unknown) => {
				return err instanceof ScopeResolutionError && err.status === 400;
			},
		);
	});

	it("gracefully handles disconnected or unavailable vaults without crashing", async () => {
		// Attach source to disconnected vault
		await contextA.sources.addSource({
			projectId: "proj_a",
			vaultId: "vault_disconnected",
			id: "src_unavail",
		});

		const res = await retrieveSections(
			contextA,
			{ query: "mechanics" },
			{ vaultRegistry: mockRegistry },
		);

		// Should still cleanly return results from the available vault
		assert.ok(res.sections.length > 0);
	});
});

// ─── Suite 5: Performance & Scale SLA (<15ms local, <50ms CI across 1,000 sections) ─────

describe("Suite 5: Performance & Scale SLA (<15ms local, <50ms CI across 1,000 sections)", () => {
	const vocabulary = [
		"quantum", "mechanics", "schrödinger", "hamiltonian", "wave", "function",
		"probability", "density", "eigenvalue", "state", "superposition", "vector",
		"matrix", "linear", "algebra", "differential", "operator", "hermitian",
		"observable", "measurement", "collapse", "hilbert", "space", "normalization",
		"newton", "dynamics", "momentum", "force", "velocity", "acceleration",
		"gravitation", "inertia", "classical", "trajectory", "energy", "potential",
	];

	function generateSyntheticSection(id: number): CandidateSection {
		const wordCount = 120 + (id % 60);
		const words: string[] = [];
		for (let i = 0; i < wordCount; i++) {
			const idx = (id * 17 + i * 31) % vocabulary.length;
			words.push(vocabulary[idx]!);
		}
		const content = words.join(" ");
		const heading = id % 7 === 0 ? "Schrödinger Wave Equation" : (id % 5 === 0 ? "Linear Algebra" : undefined);

		return {
			id: `synthetic_sec_${id}`,
			content,
			heading,
			headingHierarchy: heading ? ["Physics", heading] : ["Physics"],
			documentPath: `Section_${id % 50}.md`,
			tokenEstimate: Math.ceil(content.length / 4),
			tokens: words,
			citation: {
				sourceId: "src_synth",
				vaultId: "vault_synth",
				vaultName: "Synthetic Vault",
				documentPath: `Section_${id % 50}.md`,
				headingHierarchy: heading ? ["Physics", heading] : ["Physics"],
				lineRange: { start: 1, end: 10 },
				characterRange: { startOffset: 0, endOffset: content.length },
				deepLink: `obsidian://open?vault=Synthetic%20Vault&file=Section_${id % 50}.md`,
			},
		};
	}

	it("indexes and ranks 1,000 sections within latency SLA", () => {
		const candidateCount = 1000;
		const candidates: CandidateSection[] = new Array(candidateCount);
		for (let i = 0; i < candidateCount; i++) {
			candidates[i] = generateSyntheticSection(i);
		}

		const ranker = new SectionRanker();
		const query = "Schrödinger wave equation hamiltonian operator";

		// Full 3-pass warmup over 1,000 candidates to trigger V8 TurboFan compilation on the candidate loop
		for (let w = 0; w < 3; w++) {
			ranker.rank(candidates, query, 5);
		}

		// Benchmark execution: sample 5 iterations and use minimum duration to filter out GC/scheduling jitter
		const iterations = 5;
		const samples: number[] = [];
		let results: ReturnType<SectionRanker["rank"]> = [];
		for (let i = 0; i < iterations; i++) {
			const start = performance.now();
			results = ranker.rank(candidates, query, 5);
			samples.push(performance.now() - start);
		}
		const minDurationMs = Math.min(...samples);

		// Environment-aware SLA threshold: <15ms locally, <50ms in CI
		const maxAllowedMs = process.env.CI ? 50 : 15;

		// Assertions
		assert.equal(results.length, 5, "Must return top-5 results");
		assert.ok(
			minDurationMs < maxAllowedMs,
			`Execution duration (${minDurationMs.toFixed(2)}ms) must be strictly under ${maxAllowedMs}ms SLA (CI=${Boolean(process.env.CI)})`,
		);
		assert.ok(results[0]!.score >= results[1]!.score, "Results must be sorted descending by score");
		assert.ok(results[0]!.citation.deepLink.startsWith("obsidian://open"), "Citation must have valid deep-link");
		assert.ok(results[0]!.matchHighlights && results[0]!.matchHighlights.length > 0, "Top result must have match highlights");
	});
});
