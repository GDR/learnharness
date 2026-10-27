/**
 * Test Suite: Graph Reconciliation Engine (Milestone C Slice 5)
 *
 * Comprehensive tests covering:
 * - Suite 1: Contracts & Pure Plan Calculation (Scenarios A–D without disk I/O)
 * - Suite 2: Scenario A Integration (Unchanged document -> zero duplication, zero writes)
 * - Suite 3: Scenario B Integration (Modified document -> revision superseding & learner mastery retention)
 * - Suite 4: Scenario C Integration (Shared propositions across multiple documents & partial removal)
 * - Suite 5: Scenario D Integration (Deleted document -> evidence deactivation without destroying learner nodes/history)
 * - Suite 6: Concurrency & Mutex Safety (5 concurrent reconciliations serialized under audit lock)
 * - Suite 7: Deletion Policies ("deactivate" vs "retain")
 * - Suite 8: Idempotent Dedup Keys, Boundary Offsets & Batch Scan Reconciliation
 */

import { test, describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
	type ExtractedPropositionInput,
	type ReconciliationOptions,
	type ReconciliationPlan,
	extractedPropositionInputSchema,
	reconciliationScenarioSchema,
} from "../src/core/contracts/reconciler.ts";
import {
	computeReconciliationPlan,
	applyReconciliationPlan,
	reconcileDocument,
	reconcileScanResult,
	matchPropositionToNode,
	newGraphNodeId,
	newEvidenceId,
	GraphReconciler,
} from "../src/server/indexing/reconciler.ts";
import { createGraphStore } from "../src/store/graph.ts";
import { createPracticeStore } from "../src/store/practice.ts";
import type { GraphStore, PracticeStore } from "../src/core/ports.ts";
import type { SourceDocument, ScanResult } from "../src/core/contracts/indexing.ts";
import type { GraphNode } from "../src/core/contracts/graph.ts";
import type { SourceEvidence } from "../src/core/contracts/evidence.ts";
import { clearProjectAuditLocks } from "../src/core/audit-lock.ts";

describe("Milestone C Slice 5: Graph Reconciliation Engine", () => {
	let tempDir: string;
	let graphStore: GraphStore;
	let practiceStore: PracticeStore;
	const projectId = "proj_reconciler_test";
	const sourceId = "src_notes";

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-reconciler-test-"));
		const graphDir = path.join(tempDir, "graph");
		const practiceDir = path.join(tempDir, "practice");
		fs.mkdirSync(graphDir, { recursive: true });
		fs.mkdirSync(practiceDir, { recursive: true });
		graphStore = createGraphStore(graphDir);
		practiceStore = createPracticeStore(practiceDir);
		clearProjectAuditLocks();
	});

	afterEach(() => {
		clearProjectAuditLocks();
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup error
		}
	});

	// ─────────────────────────────────────────────────────────────────────────
	// SUITE 1: Contracts & Pure Plan Calculation
	// ─────────────────────────────────────────────────────────────────────────
	describe("Suite 1: Contracts & Pure Plan Calculation", () => {
		it("validates ExtractedPropositionInput schema with defaults", () => {
			const valid = {
				statement: "Water boils at 100 degrees Celsius at 1 atm",
			};
			const parsed = extractedPropositionInputSchema.parse(valid);
			assert.equal(parsed.statement, valid.statement);
			assert.deepEqual(parsed.aliases, []);
			assert.deepEqual(parsed.headingHierarchy, []);
			assert.equal(parsed.provenance, "explicit-source");
			assert.deepEqual(parsed.location, {});
		});

		it("rejects empty proposition statement", () => {
			assert.throws(() => extractedPropositionInputSchema.parse({ statement: "" }));
		});

		it("validates ReconciliationScenario enum values", () => {
			assert.equal(reconciliationScenarioSchema.parse("A_UNCHANGED"), "A_UNCHANGED");
			assert.equal(reconciliationScenarioSchema.parse("B_MODIFIED"), "B_MODIFIED");
			assert.equal(reconciliationScenarioSchema.parse("C_SHARED"), "C_SHARED");
			assert.equal(reconciliationScenarioSchema.parse("D_DELETED"), "D_DELETED");
			assert.throws(() => reconciliationScenarioSchema.parse("UNKNOWN_SCENARIO"));
		});

		it("matches proposition to node by exact statement, alias, and case-folding", () => {
			const existingNodes: GraphNode[] = [
				{
					id: "n_newton_01",
					name: "First Law",
					statement: "An object in motion remains in motion unless acted upon by a net external force",
					aliases: ["Law of Inertia", "Newton's First Law"],
					createdAt: "2026-01-01T00:00:00Z",
					provenance: [{ chatId: "src_1", messageId: "m1" }],
				},
			];

			// 1. Exact match
			const match1 = matchPropositionToNode(
				{ statement: "An object in motion remains in motion unless acted upon by a net external force" },
				existingNodes,
			);
			assert.equal(match1?.id, "n_newton_01");

			// 2. Alias match
			const match2 = matchPropositionToNode(
				{ statement: "Law of Inertia" },
				existingNodes,
			);
			assert.equal(match2?.id, "n_newton_01");

			// 3. Case-folded match
			const match3 = matchPropositionToNode(
				{ statement: "an object in motion remains in motion unless acted upon by a net external force" },
				existingNodes,
			);
			assert.equal(match3?.id, "n_newton_01");

			// 4. Case-folded alias match
			const match4 = matchPropositionToNode(
				{ statement: "law of inertia" },
				existingNodes,
			);
			assert.equal(match4?.id, "n_newton_01");

			// 5. No match
			const matchNone = matchPropositionToNode(
				{ statement: "Force equals mass times acceleration" },
				existingNodes,
			);
			assert.equal(matchNone, undefined);
		});

		it("computes pure plan for Scenario A (unchanged document)", () => {
			const document: SourceDocument = {
				id: "doc_1",
				sourceId,
				vaultId: "vault_1",
				currentPath: "physics/mechanics.md",
				contentHash: "hash_abc",
				revisionId: "rev_1",
				status: "active",
			};

			const existingEvidence: SourceEvidence[] = [
				{
					id: "ev_1",
					propositionId: "n_1",
					sourceId,
					documentId: "doc_1",
					revisionId: "rev_1",
					status: "active",
				},
			];

			const plan = computeReconciliationPlan({
				projectId,
				sourceId,
				document,
				existingEvidence,
				existingNodes: [],
			});

			assert.equal(plan.scenario, "A_UNCHANGED");
			assert.deepEqual(plan.evidenceToAppend, []);
			assert.deepEqual(plan.evidenceToSupersede, []);
			assert.deepEqual(plan.nodesToAppend, []);
			assert.equal(plan.unchangedEvidenceCount, 1);
		});

		it("computes pure plan for Scenario B (modified document)", () => {
			const document: SourceDocument = {
				id: "doc_1",
				sourceId,
				vaultId: "vault_1",
				currentPath: "physics/mechanics.md",
				contentHash: "hash_xyz",
				revisionId: "rev_2",
				status: "active",
			};

			const existingNodes: GraphNode[] = [
				{
					id: "n_inertia",
					name: "Inertia",
					statement: "Law of inertia",
					aliases: [],
					createdAt: "2026-01-01T00:00:00Z",
					provenance: [],
				},
			];

			const existingEvidence: SourceEvidence[] = [
				{
					id: "ev_old_1",
					propositionId: "n_inertia",
					sourceId,
					documentId: "doc_1",
					revisionId: "rev_1",
					status: "active",
				},
			];

			const extracted: ExtractedPropositionInput[] = [
				{ statement: "Law of inertia", chunkId: "c1" }, // existing
				{ statement: "Force equals mass times acceleration", chunkId: "c2" }, // new
			];

			const plan = computeReconciliationPlan({
				projectId,
				sourceId,
				document,
				extractedPropositions: extracted,
				existingEvidence,
				existingNodes,
			});

			assert.equal(plan.scenario, "B_MODIFIED");
			assert.equal(plan.evidenceToSupersede.length, 1);
			assert.ok(plan.evidenceToSupersede[0]);
			assert.equal(plan.evidenceToSupersede[0]!.id, "ev_old_1");
			assert.equal(plan.evidenceToSupersede[0]!.status, "superseded");

			assert.equal(plan.evidenceToAppend.length, 2);
			assert.deepEqual(plan.reusedPropositionIds, ["n_inertia"]);
			assert.equal(plan.createdPropositionIds.length, 1);
			assert.equal(plan.nodesToAppend.length, 1);
			assert.ok(plan.nodesToAppend[0]);
			assert.equal(plan.nodesToAppend[0]!.statement, "Force equals mass times acceleration");
		});

		it("computes pure plan for Scenario C (shared proposition in new document)", () => {
			const document: SourceDocument = {
				id: "doc_chem_1",
				sourceId,
				vaultId: "vault_1",
				currentPath: "chemistry/thermo.md",
				contentHash: "hash_chem_1",
				revisionId: "rev_chem_1",
				status: "active",
			};

			const existingNodes: GraphNode[] = [
				{
					id: "n_energy",
					name: "Conservation of Energy",
					statement: "Energy cannot be created or destroyed",
					aliases: [],
					createdAt: "2026-01-01T00:00:00Z",
					provenance: [],
				},
			];

			const allActiveEvidence: SourceEvidence[] = [
				{
					id: "ev_phys_1",
					propositionId: "n_energy",
					sourceId,
					documentId: "doc_phys_1",
					revisionId: "rev_phys_1",
					status: "active",
				},
			];

			const plan = computeReconciliationPlan({
				projectId,
				sourceId,
				document,
				extractedPropositions: [{ statement: "Energy cannot be created or destroyed" }],
				existingEvidence: [], // doc_chem_1 has no prior evidence
				existingNodes,
				allActiveEvidence,
			});

			assert.equal(plan.scenario, "C_SHARED");
			assert.deepEqual(plan.reusedPropositionIds, ["n_energy"]);
			assert.deepEqual(plan.stillSupportedPropositionIds, ["n_energy"]);
			assert.equal(plan.nodesToAppend.length, 0);
			assert.equal(plan.evidenceToAppend.length, 1);
			assert.ok(plan.evidenceToAppend[0]);
			assert.equal(plan.evidenceToAppend[0]!.propositionId, "n_energy");
		});

		it("computes pure plan for Scenario D (deleted document with orphan detection)", () => {
			const document: SourceDocument = {
				id: "doc_deleted",
				sourceId,
				vaultId: "vault_1",
				currentPath: "old_note.md",
				contentHash: "hash_old",
				revisionId: "rev_old",
				status: "missing",
			};

			const existingEvidence: SourceEvidence[] = [
				{
					id: "ev_del_1",
					propositionId: "n_isolated",
					sourceId,
					documentId: "doc_deleted",
					revisionId: "rev_old",
					status: "active",
				},
				{
					id: "ev_del_2",
					propositionId: "n_shared",
					sourceId,
					documentId: "doc_deleted",
					revisionId: "rev_old",
					status: "active",
				},
			];

			const allActiveEvidence: SourceEvidence[] = [
				...existingEvidence,
				{
					id: "ev_other_doc",
					propositionId: "n_shared",
					sourceId,
					documentId: "doc_other",
					revisionId: "rev_other",
					status: "active",
				},
			];

			const plan = computeReconciliationPlan({
				projectId,
				sourceId,
				document,
				existingEvidence,
				existingNodes: [],
				allActiveEvidence,
			});

			assert.equal(plan.scenario, "D_DELETED");
			assert.equal(plan.evidenceToSupersede.length, 2);
			assert.deepEqual(plan.nodesToAppend, []); // NEVER delete or re-create nodes
			assert.deepEqual(plan.orphanedPropositionIds, ["n_isolated"]);
			assert.deepEqual(plan.stillSupportedPropositionIds, ["n_shared"]);
		});
	});

	// ─────────────────────────────────────────────────────────────────────────
	// SUITE 2: Scenario A Integration (Unchanged Document -> Zero Duplication)
	// ─────────────────────────────────────────────────────────────────────────
	describe("Suite 2: Scenario A Integration (Unchanged Document -> Zero Duplication)", () => {
		it("skips writes and preserves byte-identical files when document revision is unchanged", async () => {
			const document: SourceDocument = {
				id: "doc_astronomy_1",
				sourceId,
				vaultId: "vault_1",
				currentPath: "space/planets.md",
				contentHash: "hash_planets_v1",
				revisionId: "rev_planets_v1",
				status: "active",
			};

			const extracted: ExtractedPropositionInput[] = [
				{ statement: "Mars has two moons named Phobos and Deimos", chunkId: "c1" },
				{ statement: "Jupiter has the strongest magnetic field of any planet", chunkId: "c2" },
			];

			// Initial reconciliation
			const firstResult = await reconcileDocument({
				projectId,
				sourceId,
				document,
				extractedPropositions: extracted,
				graphStore,
			});

			assert.equal(firstResult.status, "applied");
			assert.equal(firstResult.stats.evidenceAppended, 2);
			assert.equal(firstResult.stats.propositionsCreated, 2);

			const evidenceFile = path.join(tempDir, "graph", "evidence.jsonl");
			const nodesFile = path.join(tempDir, "graph", "nodes.jsonl");

			const evidenceSizeBefore = fs.statSync(evidenceFile).size;
			const nodesSizeBefore = fs.statSync(nodesFile).size;
			const evidenceLinesBefore = fs.readFileSync(evidenceFile, "utf-8").trim().split("\n").length;
			const nodesLinesBefore = fs.readFileSync(nodesFile, "utf-8").trim().split("\n").length;

			// Re-reconcile identical revision
			const secondResult = await reconcileDocument({
				projectId,
				sourceId,
				document,
				extractedPropositions: extracted,
				graphStore,
			});

			assert.equal(secondResult.status, "skipped");
			assert.equal(secondResult.scenario, "A_UNCHANGED");
			assert.equal(secondResult.stats.evidenceAppended, 0);
			assert.equal(secondResult.stats.evidenceSuperseded, 0);
			assert.equal(secondResult.stats.propositionsCreated, 0);

			// Assert byte-identical files on disk
			const evidenceSizeAfter = fs.statSync(evidenceFile).size;
			const nodesSizeAfter = fs.statSync(nodesFile).size;
			const evidenceLinesAfter = fs.readFileSync(evidenceFile, "utf-8").trim().split("\n").length;
			const nodesLinesAfter = fs.readFileSync(nodesFile, "utf-8").trim().split("\n").length;

			assert.equal(evidenceSizeAfter, evidenceSizeBefore);
			assert.equal(nodesSizeAfter, nodesSizeBefore);
			assert.equal(evidenceLinesAfter, evidenceLinesBefore);
			assert.equal(nodesLinesAfter, nodesLinesBefore);
		});
	});

	// ─────────────────────────────────────────────────────────────────────────
	// SUITE 3: Scenario B Integration (Modified Document & Mastery Retention)
	// ─────────────────────────────────────────────────────────────────────────
	describe("Suite 3: Scenario B Integration (Modified Document & Mastery Retention)", () => {
		it("supersedes prior revision evidence and retains proposition ID & learner practice records", async () => {
			const docV1: SourceDocument = {
				id: "doc_kepler",
				sourceId,
				vaultId: "vault_1",
				currentPath: "astronomy/kepler.md",
				contentHash: "hash_kepler_v1",
				revisionId: "rev_kepler_v1",
				status: "active",
			};

			const p1Statement = "Planets move in elliptical orbits with the Sun at one focus";
			const p2Statement = "The Sun is stationary at the exact center of the solar system";

			// 1. Initial ingestion of revision 1
			const resultV1 = await reconcileDocument({
				projectId,
				sourceId,
				document: docV1,
				extractedPropositions: [
					{ statement: p1Statement, chunkId: "chk_1" },
					{ statement: p2Statement, chunkId: "chk_2" },
				],
				graphStore,
			});

			assert.equal(resultV1.status, "applied");
			assert.equal(resultV1.stats.propositionsCreated, 2);

			const nodesAfterV1 = graphStore.readNodes();
			const p1Node = nodesAfterV1.find((n) => n.statement === p1Statement);
			assert.ok(p1Node, "P1 node must exist");
			const p1Id = p1Node.id;

			// 2. Learner engages in practice on P1
			const problemSet = await practiceStore.createProblemSet({
				projectId,
				title: "Kepler's Laws Mastery",
				nodeIds: [p1Id],
				propositions: {
					[p1Id]: { name: p1Node.name, statement: p1Node.statement },
				},
				chains: [],
			});
			assert.equal(problemSet.nodeIds[0], p1Id);

			// 3. Document modified on disk to revision 2:
			// - P1 is kept unchanged
			// - P2 is corrected to P2'
			// - P3 is newly added
			const p2PrimeStatement = "The Sun and planets orbit the common center of mass";
			const p3Statement = "The square of orbital period is proportional to cube of semi-major axis";

			const docV2: SourceDocument = {
				...docV1,
				contentHash: "hash_kepler_v2",
				revisionId: "rev_kepler_v2",
			};

			const resultV2 = await reconcileDocument({
				projectId,
				sourceId,
				document: docV2,
				extractedPropositions: [
					{ statement: p1Statement, chunkId: "chk_1_new" },
					{ statement: p2PrimeStatement, chunkId: "chk_2_new" },
					{ statement: p3Statement, chunkId: "chk_3_new" },
				],
				graphStore,
			});

			assert.equal(resultV2.status, "applied");
			assert.equal(resultV2.scenario, "B_MODIFIED");
			assert.equal(resultV2.stats.evidenceSuperseded, 2); // 2 old evidence from rev 1
			assert.equal(resultV2.stats.evidenceAppended, 3); // 3 new evidence in rev 2
			assert.deepEqual(resultV2.diagnostics.reusedPropositionIds, [p1Id]);
			assert.equal(resultV2.diagnostics.createdPropositionIds.length, 2); // P2' and P3

			// 4. Verify learner mastery preservation:
			// The practice problem set still resolves and refers to the SAME proposition ID
			const fetchedPset = await practiceStore.getProblemSet(problemSet.id);
			assert.ok(fetchedPset);
			assert.equal(fetchedPset.nodeIds[0], p1Id);
			assert.ok(fetchedPset.propositions[p1Id]);
			assert.equal(fetchedPset.propositions[p1Id]!.statement, p1Statement);

			// 5. Verify evidence ledger state
			const activeEvidence = await graphStore.readEvidence!({ status: "active" });
			assert.equal(activeEvidence.length, 3);
			assert.ok(activeEvidence.every((e) => e.revisionId === "rev_kepler_v2"));

			const p1ActiveEvidence = activeEvidence.find((e) => e.propositionId === p1Id);
			assert.ok(p1ActiveEvidence, "Active evidence for P1 must exist in rev 2");

			const supersededEvidence = await graphStore.readEvidence!({ status: "superseded" });
			assert.equal(supersededEvidence.length, 2);
			assert.ok(supersededEvidence.every((e) => e.revisionId === "rev_kepler_v1"));
		});
	});

	// ─────────────────────────────────────────────────────────────────────────
	// SUITE 4: Scenario C Integration (Shared Propositions Coexistence)
	// ─────────────────────────────────────────────────────────────────────────
	describe("Suite 4: Scenario C Integration (Shared Propositions Coexistence)", () => {
		it("allows multiple documents to share a proposition and preserves grounding when one is deleted", async () => {
			const sharedStatement = "Energy cannot be created or destroyed, only transformed";

			const docPhysics: SourceDocument = {
				id: "doc_physics_thermo",
				sourceId,
				vaultId: "vault_1",
				currentPath: "physics/thermodynamics.md",
				contentHash: "hash_phys_1",
				revisionId: "rev_phys_1",
				status: "active",
			};

			const docChemistry: SourceDocument = {
				id: "doc_chemistry_energy",
				sourceId,
				vaultId: "vault_1",
				currentPath: "chemistry/thermochemistry.md",
				contentHash: "hash_chem_1",
				revisionId: "rev_chem_1",
				status: "active",
			};

			// 1. Reconcile physics note
			const resPhys = await reconcileDocument({
				projectId,
				sourceId,
				document: docPhysics,
				extractedPropositions: [{ statement: sharedStatement, chunkId: "c_phys_1" }],
				graphStore,
			});
			assert.equal(resPhys.stats.propositionsCreated, 1);
			const sharedPropId = resPhys.diagnostics.createdPropositionIds[0];
			assert.ok(sharedPropId);

			// 2. Reconcile chemistry note (asserts identical proposition)
			const resChem = await reconcileDocument({
				projectId,
				sourceId,
				document: docChemistry,
				extractedPropositions: [{ statement: sharedStatement, chunkId: "c_chem_1" }],
				graphStore,
			});
			assert.equal(resChem.scenario, "C_SHARED");
			assert.deepEqual(resChem.diagnostics.reusedPropositionIds, [sharedPropId]);
			assert.equal(resChem.stats.propositionsCreated, 0);

			// Both evidence records exist and share the same proposition ID
			const evidenceForShared = await graphStore.getEvidenceForProposition!(sharedPropId);
			assert.equal(evidenceForShared.length, 2);
			assert.ok(evidenceForShared.some((e) => e.documentId === "doc_physics_thermo" && e.status === "active"));
			assert.ok(evidenceForShared.some((e) => e.documentId === "doc_chemistry_energy" && e.status === "active"));

			// 3. Delete physics note from disk
			const docPhysicsDeleted: SourceDocument = {
				...docPhysics,
				status: "missing",
			};

			const resDelete = await reconcileDocument({
				projectId,
				sourceId,
				document: docPhysicsDeleted,
				graphStore,
			});

			assert.equal(resDelete.scenario, "D_DELETED");
			assert.equal(resDelete.status, "superseded"); // Not orphaned, because chemistry still grounds it!
			assert.deepEqual(resDelete.diagnostics.stillSupportedPropositionIds, [sharedPropId]);
			assert.deepEqual(resDelete.diagnostics.orphanedPropositionIds, []);

			// Chemistry evidence is still active!
			const evidenceAfterDelete = await graphStore.getEvidenceForProposition!(sharedPropId);
			const activeChem = evidenceAfterDelete.find((e) => e.documentId === "doc_chemistry_energy");
			assert.ok(activeChem);
			assert.equal(activeChem.status, "active");

			const supersededPhys = evidenceAfterDelete.find((e) => e.documentId === "doc_physics_thermo");
			assert.ok(supersededPhys);
			assert.equal(supersededPhys.status, "superseded");
		});
	});

	// ─────────────────────────────────────────────────────────────────────────
	// SUITE 5: Scenario D Integration (Deleted Note & Learner Evidence Preservation)
	// ─────────────────────────────────────────────────────────────────────────
	describe("Suite 5: Scenario D Integration (Deleted Note & Learner Evidence Preservation)", () => {
		it("supersedes evidence and detects orphans while NEVER deleting GraphNode or learner records", async () => {
			const cellTheoryStatement = "All living organisms are composed of one or more cells";
			const docBio: SourceDocument = {
				id: "doc_biology_cell",
				sourceId,
				vaultId: "vault_1",
				currentPath: "biology/cell-theory.md",
				contentHash: "hash_bio_1",
				revisionId: "rev_bio_1",
				status: "active",
			};

			// 1. Ingest note
			const res = await reconcileDocument({
				projectId,
				sourceId,
				document: docBio,
				extractedPropositions: [{ statement: cellTheoryStatement, chunkId: "chk_cell_1" }],
				graphStore,
			});
			const cellNodeId = res.diagnostics.createdPropositionIds[0];
			assert.ok(cellNodeId);

			// 2. Learner practices cell theory
			const problemSet = await practiceStore.createProblemSet({
				projectId,
				title: "Cell Biology Quiz",
				nodeIds: [cellNodeId],
				propositions: {
					[cellNodeId]: { name: "Cell Theory", statement: cellTheoryStatement },
				},
				chains: [],
			});

			// 3. User deletes the note from Obsidian vault
			const docBioDeleted: SourceDocument = {
				...docBio,
				status: "missing",
			};

			const deleteResult = await reconcileDocument({
				projectId,
				sourceId,
				document: docBioDeleted,
				graphStore,
			});

			assert.equal(deleteResult.scenario, "D_DELETED");
			assert.equal(deleteResult.status, "orphaned");
			assert.deepEqual(deleteResult.diagnostics.orphanedPropositionIds, [cellNodeId]);
			assert.equal(deleteResult.stats.evidenceSuperseded, 1);

			// ─── MANDATORY INVARIANT CHECKS ───
			// 1. GraphNode MUST STILL EXIST in nodes.jsonl
			const allNodes = graphStore.readNodes();
			const cellNode = allNodes.find((n) => n.id === cellNodeId);
			assert.ok(cellNode, "GraphNode MUST NOT be deleted when source note is deleted (Invariant 2)");
			assert.equal(cellNode.statement, cellTheoryStatement);

			// 2. PracticeStore ProblemSet MUST STILL EXIST
			const pset = await practiceStore.getProblemSet(problemSet.id);
			assert.ok(pset, "ProblemSet MUST NOT be deleted (Invariant 4)");
			assert.equal(pset.nodeIds[0], cellNodeId);

			// 3. Historical evidence is preserved as superseded for citations/auditing
			const evidence = await graphStore.getEvidenceForProposition!(cellNodeId);
			assert.equal(evidence.length, 1);
			assert.ok(evidence[0]);
			assert.equal(evidence[0]!.status, "superseded");
		});
	});

	// ─────────────────────────────────────────────────────────────────────────
	// SUITE 6: Concurrency & Mutex Safety
	// ─────────────────────────────────────────────────────────────────────────
	describe("Suite 6: Concurrency & Mutex Safety", () => {
		it("serializes 5 concurrent reconcileDocument calls cleanly under project lock without file corruption", async () => {
			const numDocs = 5;
			const docs: SourceDocument[] = Array.from({ length: numDocs }, (_, i) => ({
				id: `doc_concurrent_${i}`,
				sourceId,
				vaultId: "vault_1",
				currentPath: `concurrent/note_${i}.md`,
				contentHash: `hash_conc_${i}`,
				revisionId: `rev_conc_${i}`,
				status: "active",
			}));

			// Launch 5 concurrent reconciliations simultaneously
			const promises = docs.map((doc, i) =>
				reconcileDocument({
					projectId,
					sourceId,
					document: doc,
					extractedPropositions: [
						{
							statement: `Unique concurrent proposition statement #${i} about subject ${i}`,
							chunkId: `chk_${i}`,
						},
					],
					graphStore,
				}),
			);

			const results = await Promise.all(promises);

			// Assert all completed successfully
			assert.equal(results.length, 5);
			assert.ok(results.every((r) => r.status === "applied"));

			// Check evidence.jsonl: every single line must be valid JSON
			const evidenceFile = path.join(tempDir, "graph", "evidence.jsonl");
			assert.ok(fs.existsSync(evidenceFile));
			const evidenceContent = fs.readFileSync(evidenceFile, "utf-8").trim();
			const evidenceLines = evidenceContent.split("\n");
			assert.equal(evidenceLines.length, 5);

			for (const line of evidenceLines) {
				assert.doesNotThrow(() => JSON.parse(line), `Every evidence line must be valid JSON: "${line}"`);
			}

			// Check nodes.jsonl: every line must be valid JSON
			const nodesFile = path.join(tempDir, "graph", "nodes.jsonl");
			assert.ok(fs.existsSync(nodesFile));
			const nodesContent = fs.readFileSync(nodesFile, "utf-8").trim();
			const nodesLines = nodesContent.split("\n");
			assert.equal(nodesLines.length, 5);

			for (const line of nodesLines) {
				assert.doesNotThrow(() => JSON.parse(line), `Every node line must be valid JSON: "${line}"`);
			}

			// In-memory read matches line count exactly
			const storedEvidence = await graphStore.readEvidence!();
			assert.equal(storedEvidence.length, 5);
			const storedNodes = graphStore.readNodes();
			assert.equal(storedNodes.length, 5);
		});
	});

	// ─────────────────────────────────────────────────────────────────────────
	// SUITE 7: Deletion Policies ("deactivate" vs "retain")
	// ─────────────────────────────────────────────────────────────────────────
	describe("Suite 7: Deletion Policies ('deactivate' vs 'retain')", () => {
		it("preserves active evidence when deletionPolicy is 'retain'", async () => {
			const doc: SourceDocument = {
				id: "doc_policy_retain",
				sourceId,
				vaultId: "vault_1",
				currentPath: "policy/archive.md",
				contentHash: "hash_pol_1",
				revisionId: "rev_pol_1",
				status: "active",
			};

			await reconcileDocument({
				projectId,
				sourceId,
				document: doc,
				extractedPropositions: [{ statement: "Archived historical note statement" }],
				graphStore,
			});

			const activeBefore = await graphStore.readEvidence!({ status: "active" });
			assert.equal(activeBefore.length, 1);

			// Missing document with deletionPolicy: "retain"
			const docMissing: SourceDocument = { ...doc, status: "missing" };
			const res = await reconcileDocument({
				projectId,
				sourceId,
				document: docMissing,
				graphStore,
				options: { deletionPolicy: "retain" },
			});

			assert.equal(res.status, "skipped");
			assert.equal(res.stats.evidenceSuperseded, 0);

			const activeAfter = await graphStore.readEvidence!({ status: "active" });
			assert.equal(activeAfter.length, 1, "Evidence remains active under retain policy");
		});

		it("supersedes evidence when deletionPolicy is 'deactivate' (default)", async () => {
			const doc: SourceDocument = {
				id: "doc_policy_deactivate",
				sourceId,
				vaultId: "vault_1",
				currentPath: "policy/temp.md",
				contentHash: "hash_pol_2",
				revisionId: "rev_pol_2",
				status: "active",
			};

			await reconcileDocument({
				projectId,
				sourceId,
				document: doc,
				extractedPropositions: [{ statement: "Temporary note statement" }],
				graphStore,
			});

			const docMissing: SourceDocument = { ...doc, status: "missing" };
			const res = await reconcileDocument({
				projectId,
				sourceId,
				document: docMissing,
				graphStore,
				options: { deletionPolicy: "deactivate" },
			});

			assert.equal(res.status, "orphaned");
			assert.equal(res.stats.evidenceSuperseded, 1);

			const activeAfter = await graphStore.readEvidence!({ status: "active" });
			assert.equal(activeAfter.length, 0);
			const supersededAfter = await graphStore.readEvidence!({ status: "superseded" });
			assert.equal(supersededAfter.length, 1);
		});
	});

	// ─────────────────────────────────────────────────────────────────────────
	// SUITE 8: Idempotent Dedup Keys, Boundary Offsets & Batch Scan Reconciliation
	// ─────────────────────────────────────────────────────────────────────────
	describe("Suite 8: Idempotent Dedup Keys, Boundary Offsets & Batch Scan Reconciliation", () => {
		it("disambiguates propositions extracted from same chunk at different character offsets", async () => {
			const doc: SourceDocument = {
				id: "doc_multi_offset",
				sourceId,
				vaultId: "vault_1",
				currentPath: "offsets/multi.md",
				contentHash: "hash_off_1",
				revisionId: "rev_off_1",
				status: "active",
			};

			const extracted: ExtractedPropositionInput[] = [
				{
					statement: "First proposition in chunk",
					chunkId: "chk_shared",
					range: { startOffset: 0, endOffset: 50 },
				},
				{
					statement: "Second proposition in same chunk at different offset",
					chunkId: "chk_shared",
					range: { startOffset: 51, endOffset: 120 },
				},
			];

			const res = await reconcileDocument({
				projectId,
				sourceId,
				document: doc,
				extractedPropositions: extracted,
				graphStore,
			});

			assert.equal(res.stats.evidenceAppended, 2);
			const evidence = await graphStore.readEvidence!({ status: "active" });
			assert.equal(evidence.length, 2);
			assert.ok(evidence[0]);
			assert.ok(evidence[1]);
			assert.notEqual(evidence[0]!.id, evidence[1]!.id);
			assert.equal(evidence[0]!.location?.startOffset, 0);
			assert.equal(evidence[1]!.location?.startOffset, 51);
		});

		it("deduplicates identical proposition extracted twice with identical dedup key", async () => {
			const doc: SourceDocument = {
				id: "doc_exact_dup",
				sourceId,
				vaultId: "vault_1",
				currentPath: "offsets/dup.md",
				contentHash: "hash_dup_1",
				revisionId: "rev_dup_1",
				status: "active",
			};

			const extracted: ExtractedPropositionInput[] = [
				{
					statement: "Identical proposition statement",
					chunkId: "chk_1",
					range: { startOffset: 10, endOffset: 50 },
				},
				{
					statement: "Identical proposition statement",
					chunkId: "chk_1",
					range: { startOffset: 10, endOffset: 50 }, // exact duplicate
				},
			];

			const res = await reconcileDocument({
				projectId,
				sourceId,
				document: doc,
				extractedPropositions: extracted,
				graphStore,
			});

			assert.equal(res.stats.evidenceAppended, 1);
			assert.equal(res.diagnostics.dedupSkippedCount, 1);
		});

		it("reconciles full ScanResult across added, unchanged, modified, and removed documents", async () => {
			// First, seed an existing document doc_old
			const docOld: SourceDocument = {
				id: "doc_old",
				sourceId,
				vaultId: "vault_1",
				currentPath: "notes/old.md",
				contentHash: "hash_old_v1",
				revisionId: "rev_old_v1",
				status: "active",
			};
			await reconcileDocument({
				projectId,
				sourceId,
				document: docOld,
				extractedPropositions: [{ statement: "Old statement to be removed" }],
				graphStore,
			});

			// Also seed an unchanged document
			const docUnchanged: SourceDocument = {
				id: "doc_unchanged",
				sourceId,
				vaultId: "vault_1",
				currentPath: "notes/unchanged.md",
				contentHash: "hash_unchanged_v1",
				revisionId: "rev_unchanged_v1",
				status: "active",
			};
			await reconcileDocument({
				projectId,
				sourceId,
				document: docUnchanged,
				extractedPropositions: [{ statement: "Unchanged note statement" }],
				graphStore,
			});

			// Now construct a ScanResult with:
			// 1. doc_unchanged (unchanged)
			// 2. doc_new (added)
			// 3. doc_old (removed/missing)
			const docNew: SourceDocument = {
				id: "doc_new",
				sourceId,
				vaultId: "vault_1",
				currentPath: "notes/new.md",
				contentHash: "hash_new_v1",
				revisionId: "rev_new_v1",
				status: "active",
			};
			const docOldRemoved: SourceDocument = {
				...docOld,
				status: "missing",
			};

			const scanResult: ScanResult = {
				sourceId,
				vaultId: "vault_1",
				scannedCount: 3,
				addedCount: 1,
				modifiedCount: 0,
				unchangedCount: 1,
				removedCount: 1,
				documents: [docUnchanged, docNew, docOldRemoved],
			};

			const summary = await reconcileScanResult({
				projectId,
				sourceId,
				scanResult,
				extractedPropositionsByDocId: {
					doc_new: [{ statement: "New document statement" }],
					doc_unchanged: [{ statement: "Unchanged note statement" }],
				},
				graphStore,
			});

			assert.equal(summary.totalDocuments, 3);
			assert.equal(summary.addedDocuments, 1);
			assert.equal(summary.unchangedDocuments, 1);
			assert.equal(summary.deletedDocuments, 1);
			assert.equal(summary.totalEvidenceAppended, 1); // only doc_new
			assert.equal(summary.totalEvidenceSuperseded, 1); // doc_old
			assert.equal(summary.totalPropositionsCreated, 1);
			assert.equal(summary.totalPropositionsOrphaned, 1);
			assert.equal(summary.documentResults.length, 3);
		});

		it("operates via GraphReconciler convenience class", async () => {
			const reconciler = new GraphReconciler(projectId, graphStore);
			const doc: SourceDocument = {
				id: "doc_helper_class",
				sourceId,
				vaultId: "vault_1",
				currentPath: "helper/test.md",
				contentHash: "hash_help_1",
				revisionId: "rev_help_1",
				status: "active",
			};

			const res = await reconciler.reconcileDocument(sourceId, doc, [
				{ statement: "Statement using helper class instance" },
			]);
			assert.equal(res.status, "applied");
			assert.equal(res.stats.propositionsCreated, 1);

			const scanResult: ScanResult = {
				sourceId,
				vaultId: "vault_1",
				scannedCount: 1,
				addedCount: 0,
				modifiedCount: 0,
				unchangedCount: 1,
				removedCount: 0,
				documents: [doc],
			};

			const summary = await reconciler.reconcileScanResult(sourceId, scanResult);
			assert.equal(summary.unchangedDocuments, 1);
			assert.equal(summary.totalEvidenceAppended, 0);
		});

		it("generates random valid IDs with newGraphNodeId and newEvidenceId", () => {
			const nId1 = newGraphNodeId();
			const nId2 = newGraphNodeId();
			assert.match(nId1, /^n_[0-9a-f]{12}$/);
			assert.notEqual(nId1, nId2);

			const evId1 = newEvidenceId();
			const evId2 = newEvidenceId();
			assert.match(evId1, /^ev_[0-9a-f]{16}$/);
			assert.notEqual(evId1, evId2);
		});
	});
});
