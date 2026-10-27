/**
 * Test Suite: Atomic Commits, Invariant Validation & Crash Safety (Milestone C Slice 6)
 *
 * Verifies:
 * - Suite 1: Generation Counter & Manifest Protocol (Monotonic progression, checksums, schema compliance)
 * - Suite 2: Staging Area & Pre-Commit Invariant Enforcement (Zero orphan evidence, syntax validation, cleanup)
 * - Suite 3: Scenario E — Concurrency & Serialization (Promise.all 10 commits, shared proposition dedup, optimistic conflict)
 * - Suite 4: Scenario F — Crash Rollback & Integrity Recovery (Staging crash, mid-swap crash, torn line repair, programmatic rollback)
 * - Suite 5: Full Reconciler Integration with Atomic Generation Commits (Scenarios A–D E2E under lock)
 * - Suite 6: Scale & Recovery Latency Benchmarks (Throughput & sub-50ms boot recovery)
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
	projectGenerationRecordSchema,
	commitJournalRecordSchema,
	CommitInvariantError,
	GenerationConflictError,
	type ProjectGenerationRecord,
	type CommitJournalRecord,
} from "../src/core/contracts/generation.ts";
import {
	computeLedgerSnapshot,
	computeFileSha256,
	getProjectGeneration,
	executeGenerationCommit,
	recoverGraphStore,
	rollbackGraphGeneration,
	validatePreCommitInvariants,
} from "../src/store/graph-generation.ts";
import { createGraphStore } from "../src/store/graph.ts";
import type { GraphStore } from "../src/core/ports.ts";
import type { GraphNode } from "../src/core/contracts/graph.ts";
import type { SourceEvidence } from "../src/core/contracts/evidence.ts";
import type { SourceDocument } from "../src/core/contracts/indexing.ts";
import {
	reconcileDocument,
	newGraphNodeId,
	newEvidenceId,
} from "../src/server/indexing/reconciler.ts";
import { clearProjectAuditLocks } from "../src/core/audit-lock.ts";

function makeNode(id: string, statement: string, name = statement): GraphNode {
	return {
		id,
		name,
		statement,
		aliases: [],
		createdAt: new Date().toISOString(),
		provenance: [{ chatId: "chat_1", messageId: "msg_1" }],
	};
}

function makeEvidence(
	id: string,
	propId: string,
	docId: string,
	options: {
		status?: "active" | "superseded";
		revId?: string;
		sourceId?: string;
		projectId?: string;
		startOffset?: number;
	} = {},
): SourceEvidence {
	return {
		id,
		propositionId: propId,
		sourceId: options.sourceId ?? "src_1",
		documentId: docId,
		revisionId: options.revId ?? "rev_1",
		status: options.status ?? "active",
		provenance: "explicit-source",
		extractorVersion: "1.0.0",
		projectId: options.projectId ?? "proj_atomic_test",
		location: { startOffset: options.startOffset ?? 0, endOffset: (options.startOffset ?? 0) + 20 },
	};
}

describe("Milestone C Slice 6: Atomic Commits & Crash Safety", () => {
	let tempDir: string;
	let graphDir: string;
	let graphStore: GraphStore;
	const projectId = "proj_atomic_test";

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-atomic-commit-test-"));
		graphDir = path.join(tempDir, "graph");
		fs.mkdirSync(graphDir, { recursive: true });
		clearProjectAuditLocks();
		graphStore = createGraphStore(graphDir);
	});

	afterEach(() => {
		clearProjectAuditLocks();
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup error
		}
	});

	// ─── SUITE 1: GENERATION COUNTER & MANIFEST PROTOCOL ───────────────────────
	describe("Suite 1: Generation Counter & Manifest Protocol", () => {
		it("Test 1.1: New project auto-initializes generation.json at generation 0 with valid checksums and zero byte offsets", async () => {
			const gen = await graphStore.getGeneration!();
			assert.equal(gen.generation, 0);
			assert.equal(gen.status, "committed");
			assert.equal(gen.snapshots.nodes.lineCount, 0);
			assert.equal(gen.snapshots.nodes.byteOffset, 0);
			assert.equal(gen.snapshots.evidence.lineCount, 0);
			assert.equal(gen.snapshots.evidence.byteOffset, 0);

			const genFile = path.join(graphDir, "generation.json");
			assert.ok(fs.existsSync(genFile), "generation.json must exist on disk");
			const raw = JSON.parse(fs.readFileSync(genFile, "utf-8"));
			const parsed = projectGenerationRecordSchema.safeParse(raw);
			assert.ok(parsed.success, "generation.json must validate against projectGenerationRecordSchema");
		});

		it("Test 1.2: Sequential commits strictly increment generation number 0 -> 1 -> 2 -> 3", async () => {
			const gen0 = await graphStore.getGeneration!();
			assert.equal(gen0.generation, 0);

			// Commit 1
			const node1 = makeNode("n_1", "Statement 1");
			const ev1 = makeEvidence("ev_1", "n_1", "doc_1");
			const res1 = await graphStore.commitGeneration!({
				projectId,
				nodesToAppend: [node1],
				evidenceBatch: [ev1],
			});
			assert.equal(res1.generation, 1);
			assert.equal(res1.previousGeneration, 0);

			// Commit 2
			const node2 = makeNode("n_2", "Statement 2");
			const ev2 = makeEvidence("ev_2", "n_2", "doc_1");
			const res2 = await graphStore.commitGeneration!({
				projectId,
				nodesToAppend: [node2],
				evidenceBatch: [ev2],
			});
			assert.equal(res2.generation, 2);
			assert.equal(res2.previousGeneration, 1);

			// Commit 3
			const node3 = makeNode("n_3", "Statement 3");
			const ev3 = makeEvidence("ev_3", "n_3", "doc_2");
			const res3 = await graphStore.commitGeneration!({
				projectId,
				nodesToAppend: [node3],
				evidenceBatch: [ev3],
			});
			assert.equal(res3.generation, 3);
			assert.equal(res3.previousGeneration, 2);

			const currentGen = await graphStore.getGeneration!();
			assert.equal(currentGen.generation, 3);
		});

		it("Test 1.3: generation.json is formatted with valid 2-space indentation", async () => {
			const node = makeNode("n_fmt", "Formatting statement");
			const ev = makeEvidence("ev_fmt", "n_fmt", "doc_fmt");
			await graphStore.commitGeneration!({
				projectId,
				nodesToAppend: [node],
				evidenceBatch: [ev],
			});

			const genFile = path.join(graphDir, "generation.json");
			const content = fs.readFileSync(genFile, "utf-8");
			assert.ok(content.includes('  "generation": 1'), "generation.json must use 2-space indentation");
			assert.ok(content.endsWith("\n"), "generation.json must end with newline");
		});

		it("Test 1.4: Snapshot fields (sha256, byteOffset, lineCount) match exact physical file measurements", async () => {
			const node1 = makeNode("n_phy1", "Physical test 1");
			const node2 = makeNode("n_phy2", "Physical test 2");
			const ev1 = makeEvidence("ev_phy1", "n_phy1", "doc_phy");
			const ev2 = makeEvidence("ev_phy2", "n_phy2", "doc_phy");

			const commitRes = await graphStore.commitGeneration!({
				projectId,
				nodesToAppend: [node1, node2],
				evidenceBatch: [ev1, ev2],
			});

			const nodesFile = path.join(graphDir, "nodes.jsonl");
			const evidenceFile = path.join(graphDir, "evidence.jsonl");

			const actualNodesStat = fs.statSync(nodesFile);
			const actualEvidenceStat = fs.statSync(evidenceFile);
			const actualNodesHash = computeFileSha256(nodesFile);
			const actualEvidenceHash = computeFileSha256(evidenceFile);

			assert.equal(commitRes.snapshots.nodes.byteOffset, actualNodesStat.size);
			assert.equal(commitRes.snapshots.nodes.sha256, actualNodesHash);
			assert.equal(commitRes.snapshots.nodes.lineCount, 2);

			assert.equal(commitRes.snapshots.evidence.byteOffset, actualEvidenceStat.size);
			assert.equal(commitRes.snapshots.evidence.sha256, actualEvidenceHash);
			assert.equal(commitRes.snapshots.evidence.lineCount, 2);
		});
	});

	// ─── SUITE 2: STAGING AREA & PRE-COMMIT INVARIANT ENFORCEMENT ───────────────
	describe("Suite 2: Staging Area & Pre-Commit Invariant Enforcement", () => {
		it("Test 2.1: Malformed node definition (empty id or missing statement) throws CommitInvariantError; live nodes.jsonl remains untouched", async () => {
			const validNode = makeNode("n_init", "Initial valid node");
			const validEv = makeEvidence("ev_init", "n_init", "doc_init");
			await graphStore.commitGeneration!({
				projectId,
				nodesToAppend: [validNode],
				evidenceBatch: [validEv],
			});

			const nodesFile = path.join(graphDir, "nodes.jsonl");
			const nodesBefore = fs.readFileSync(nodesFile, "utf-8");

			// Attempt committing malformed node (empty statement)
			const badNode = {
				id: "n_bad",
				name: "bad",
				statement: "", // Empty statement!
				aliases: [],
				createdAt: new Date().toISOString(),
				provenance: [],
			} as unknown as GraphNode;

			await assert.rejects(
				async () => {
					await graphStore.commitGeneration!({
						projectId,
						nodesToAppend: [badNode],
					});
				},
				(err: unknown) => {
					assert.ok(err instanceof CommitInvariantError);
					assert.equal((err as CommitInvariantError).status, 422);
					return true;
				},
			);

			const nodesAfter = fs.readFileSync(nodesFile, "utf-8");
			assert.equal(nodesAfter, nodesBefore, "Live nodes.jsonl must remain completely unchanged");
		});

		it("Test 2.2: Orphan evidence rejection: candidate SourceEvidence pointing to non-existent propositionId throws CommitInvariantError", async () => {
			const orphanEvidence = makeEvidence("ev_orphan", "n_ghost_prop", "doc_1");

			await assert.rejects(
				async () => {
					await graphStore.commitGeneration!({
						projectId,
						evidenceBatch: [orphanEvidence],
					});
				},
				(err: unknown) => {
					assert.ok(err instanceof CommitInvariantError);
					assert.match((err as CommitInvariantError).message, /non-existent proposition "n_ghost_prop"/);
					assert.equal((err as CommitInvariantError).details?.orphanPropositionId, "n_ghost_prop");
					return true;
				},
			);

			const evidenceFile = path.join(graphDir, "evidence.jsonl");
			assert.ok(!fs.existsSync(evidenceFile) || fs.statSync(evidenceFile).size === 0);
		});

		it("Test 2.3: Conflicting duplicate active evidence with identical dedup key in batch throws CommitInvariantError", async () => {
			const node = makeNode("n_dedup", "Dedup statement");
			const ev1 = makeEvidence("ev_dup1", "n_dedup", "doc_1", { startOffset: 10 });
			const ev2 = makeEvidence("ev_dup2", "n_dedup", "doc_1", { startOffset: 10 }); // Identical dedup key!

			await assert.rejects(
				async () => {
					await graphStore.commitGeneration!({
						projectId,
						nodesToAppend: [node],
						evidenceBatch: [ev1, ev2],
					});
				},
				(err: unknown) => {
					assert.ok(err instanceof CommitInvariantError);
					assert.match((err as CommitInvariantError).message, /Conflicting duplicate active evidence/);
					return true;
				},
			);
		});

		it("Test 2.4: Staging directory cleanup: temporary files in .staging/ are purged on invariant rejection", async () => {
			const orphanEvidence = makeEvidence("ev_orphan", "n_absent", "doc_1");
			const stagingDir = path.join(graphDir, ".staging");

			try {
				await graphStore.commitGeneration!({
					projectId,
					evidenceBatch: [orphanEvidence],
				});
				assert.fail("Should have thrown CommitInvariantError");
			} catch (err) {
				assert.ok(err instanceof CommitInvariantError);
			}

			assert.ok(!fs.existsSync(stagingDir), ".staging directory must be cleaned up on failure");
		});
	});

	// ─── SUITE 3: SCENARIO E — CONCURRENCY & SERIALIZATION ─────────────────────
	describe("Suite 3: Scenario E — Concurrency & Serialization", () => {
		it("Test 3.1: 10 concurrent commitGeneration promises serialized cleanly without torn lines", async () => {
			const promises = Array.from({ length: 10 }, (_, i) => {
				const node = makeNode(`n_conc_${i}`, `Concurrent Statement ${i}`);
				const ev = makeEvidence(`ev_conc_${i}`, `n_conc_${i}`, `doc_conc_${i}`);
				return graphStore.commitGeneration!({
					projectId,
					nodesToAppend: [node],
					evidenceBatch: [ev],
				});
			});

			const results = await Promise.all(promises);
			assert.equal(results.length, 10);

			const finalGen = await graphStore.getGeneration!();
			assert.equal(finalGen.generation, 10, "Generation must reach 10 sequentially");

			const nodesFile = path.join(graphDir, "nodes.jsonl");
			const evidenceFile = path.join(graphDir, "evidence.jsonl");

			const nodeLines = fs.readFileSync(nodesFile, "utf-8").trim().split("\n");
			const evLines = fs.readFileSync(evidenceFile, "utf-8").trim().split("\n");

			assert.equal(nodeLines.length, 10);
			assert.equal(evLines.length, 10);

			// Every single line must parse cleanly
			for (const l of nodeLines) {
				assert.doesNotThrow(() => JSON.parse(l), "Every node line must be valid JSON");
			}
			for (const l of evLines) {
				assert.doesNotThrow(() => JSON.parse(l), "Every evidence line must be valid JSON");
			}
		});

		it("Test 3.2: Scenario E proposition race: 5 concurrent reconcileDocument calls for SAME proposition yield exactly 1 GraphNode and 5 shared evidence", async () => {
			const statement = "Photosynthesis converts light into chemical energy";

			const docInputs: SourceDocument[] = Array.from({ length: 5 }, (_, i) => ({
				id: `doc_shared_${i}`,
				sourceId: "src_bio",
				vaultId: "vault_1",
				currentPath: `notes/bio_${i}.md`,
				contentHash: `hash_${i}`,
				revisionId: `rev_${i}`,
				status: "active",
			}));

			// Launch 5 concurrent reconciliations asserting identical proposition
			const promises = docInputs.map((doc, idx) =>
				reconcileDocument({
					projectId,
					sourceId: "src_bio",
					document: doc,
					extractedPropositions: [
						{
							statement,
							heading: "Overview",
							location: {
								startOffset: 10 * idx,
								endOffset: 10 * idx + 30,
							},
						},
					],
					graphStore,
				}),
			);

			const results = await Promise.all(promises);
			assert.equal(results.length, 5);

			// Verify only 1 node created across all 5 jobs
			const nodes = graphStore.readNodes();
			const matchingNodes = nodes.filter((n) => n.statement === statement);
			assert.equal(matchingNodes.length, 1, "Exactly 1 GraphNode must exist for the shared proposition");

			// Verify 5 active evidence records attached to this single node
			const singlePropId = matchingNodes[0]!.id;
			const evidence = await graphStore.getEvidenceForProposition!(singlePropId);
			assert.equal(evidence.length, 5, "All 5 documents must link to the single proposition");
			assert.ok(evidence.every((e) => e.status === "active"));
		});

		it("Test 3.3: Optimistic concurrency collision: commit with stale baseGeneration throws GenerationConflictError (409)", async () => {
			const node1 = makeNode("n_base1", "Base proposition 1");
			const ev1 = makeEvidence("ev_base1", "n_base1", "doc_1");
			await graphStore.commitGeneration!({
				projectId,
				nodesToAppend: [node1],
				evidenceBatch: [ev1],
			});

			// Generation is now 1
			const gen1 = await graphStore.getGeneration!();
			assert.equal(gen1.generation, 1);

			// Another job commits generation 2
			const node2 = makeNode("n_base2", "Base proposition 2");
			const ev2 = makeEvidence("ev_base2", "n_base2", "doc_1");
			await graphStore.commitGeneration!({
				projectId,
				nodesToAppend: [node2],
				evidenceBatch: [ev2],
			});

			const gen2 = await graphStore.getGeneration!();
			assert.equal(gen2.generation, 2);

			// Original job attempts commit with stale baseGeneration: 1
			const node3 = makeNode("n_base3", "Base proposition 3");
			const ev3 = makeEvidence("ev_base3", "n_base3", "doc_1");

			await assert.rejects(
				async () => {
					await graphStore.commitGeneration!({
						projectId,
						nodesToAppend: [node3],
						evidenceBatch: [ev3],
						baseGeneration: 1, // Stale! Current is 2
					});
				},
				(err: unknown) => {
					assert.ok(err instanceof GenerationConflictError);
					assert.equal((err as GenerationConflictError).status, 409);
					assert.equal((err as GenerationConflictError).expectedGeneration, 1);
					assert.equal((err as GenerationConflictError).currentGeneration, 2);
					return true;
				},
			);
		});

		it("Test 3.4: Cross-project parallelism: 5 commits on proj_A and 5 on proj_B execute concurrently without lock contention", async () => {
			const projA = "proj_alpha";
			const projB = "proj_beta";

			const dirA = path.join(tempDir, "graphA");
			const dirB = path.join(tempDir, "graphB");
			fs.mkdirSync(dirA, { recursive: true });
			fs.mkdirSync(dirB, { recursive: true });

			const storeA = createGraphStore(dirA);
			const storeB = createGraphStore(dirB);

			const tasksA = Array.from({ length: 5 }, (_, i) => {
				const node = makeNode(`n_a_${i}`, `A statement ${i}`);
				const ev = makeEvidence(`ev_a_${i}`, `n_a_${i}`, `doc_a_${i}`, { projectId: projA });
				return storeA.commitGeneration!({
					projectId: projA,
					nodesToAppend: [node],
					evidenceBatch: [ev],
				});
			});

			const tasksB = Array.from({ length: 5 }, (_, i) => {
				const node = makeNode(`n_b_${i}`, `B statement ${i}`);
				const ev = makeEvidence(`ev_b_${i}`, `n_b_${i}`, `doc_b_${i}`, { projectId: projB });
				return storeB.commitGeneration!({
					projectId: projB,
					nodesToAppend: [node],
					evidenceBatch: [ev],
				});
			});

			await Promise.all([...tasksA, ...tasksB]);

			const genA = await storeA.getGeneration!();
			const genB = await storeB.getGeneration!();

			assert.equal(genA.generation, 5);
			assert.equal(genB.generation, 5);
		});
	});

	// ─── SUITE 4: SCENARIO F — CRASH ROLLBACK & INTEGRITY RECOVERY ─────────────
	describe("Suite 4: Scenario F — Crash Rollback & Integrity Recovery", () => {
		it("Test 4.1: Simulated crash during staging: uncommitted staging files are purged upon boot", async () => {
			const node = makeNode("n_c1", "Statement before crash");
			const ev = makeEvidence("ev_c1", "n_c1", "doc_c");
			await graphStore.commitGeneration!({
				projectId,
				nodesToAppend: [node],
				evidenceBatch: [ev],
			});

			// Plant interrupted staging directory
			const stagingDir = path.join(graphDir, ".staging");
			const fakeGenStaging = path.join(stagingDir, "gen-2");
			fs.mkdirSync(fakeGenStaging, { recursive: true });
			fs.writeFileSync(path.join(fakeGenStaging, "nodes.jsonl"), '{"id":"torn"\n');

			// Re-initialize GraphStore (simulating reboot)
			const rebootStore = createGraphStore(graphDir);
			const gen = await rebootStore.getGeneration!();
			assert.equal(gen.generation, 1, "Generation must stay at 1");
			assert.ok(!fs.existsSync(stagingDir), "Staging directory must be cleaned up on boot");
		});

		it("Test 4.2: Simulated crash mid-swap: restores nodes.jsonl from backup to generation 1 with byte-for-byte fidelity", async () => {
			const node1 = makeNode("n_stable", "Stable proposition");
			const ev1 = makeEvidence("ev_stable", "n_stable", "doc_stable");
			await graphStore.commitGeneration!({
				projectId,
				nodesToAppend: [node1],
				evidenceBatch: [ev1],
			});

			const nodesFile = path.join(graphDir, "nodes.jsonl");
			const stableContent = fs.readFileSync(nodesFile, "utf-8");

			// Simulate mid-swap crash:
			// 1. Create backup dir with stable files
			const stagingDir = path.join(graphDir, ".staging");
			const backupDir = path.join(stagingDir, "backup-gen-1");
			fs.mkdirSync(backupDir, { recursive: true });
			fs.writeFileSync(path.join(backupDir, "nodes.jsonl"), stableContent);

			// 2. Write in-flight journal in "swapping" stage
			const journal: CommitJournalRecord = {
				projectId,
				targetGeneration: 2,
				previousGeneration: 1,
				commitId: "crash-test-commit",
				stage: "swapping",
				status: "staged",
				startedAt: new Date().toISOString(),
				stagingDir: path.join(stagingDir, "gen-2"),
				backupDir,
				stagedFiles: {},
			};
			fs.writeFileSync(path.join(stagingDir, "journal.json"), JSON.stringify(journal));

			// 3. Overwrite live nodes.jsonl with corrupt partial content
			fs.writeFileSync(nodesFile, '{"id":"n_corrupt_torn_write","name":"torn"}\n');

			// Trigger boot recovery
			const report = await recoverGraphStore(graphDir);
			assert.equal(report.action, "rolled_back");
			assert.equal(report.generation, 1);

			// Check canonical nodes.jsonl is restored
			const restoredContent = fs.readFileSync(nodesFile, "utf-8");
			assert.equal(restoredContent, stableContent, "nodes.jsonl must match exact pre-crash byte fidelity");
		});

		it("Test 4.3: Torn line truncation: recovery detects byte offset exceeding generation snapshot and truncates file back to last valid committed offset", async () => {
			const node = makeNode("n_valid", "Valid node statement");
			const ev = makeEvidence("ev_valid", "n_valid", "doc_valid");
			await graphStore.commitGeneration!({
				projectId,
				nodesToAppend: [node],
				evidenceBatch: [ev],
			});

			const nodesFile = path.join(graphDir, "nodes.jsonl");
			const originalSize = fs.statSync(nodesFile).size;

			// Append corrupt torn line simulating sudden SIGKILL mid-append
			fs.appendFileSync(nodesFile, '{"id":"n_torn_line", "state');
			assert.ok(fs.statSync(nodesFile).size > originalSize);

			// Explicit recovery detects corrupt line and repairs file back to committed offset
			const report = await recoverGraphStore(graphDir);
			assert.equal(report.action, "repaired");

			// Assert file size is truncated back to exact committed byteOffset
			const repairedSize = fs.statSync(nodesFile).size;
			assert.equal(repairedSize, originalSize);

			// Re-initialize GraphStore and verify readNodes
			const freshStore = createGraphStore(graphDir);
			const nodes = freshStore.readNodes();
			assert.equal(nodes.length, 1);
			assert.equal(nodes[0]!.id, "n_valid");

			// Now test boot auto-recovery: append another corrupt line and verify createGraphStore auto-repairs on boot
			fs.appendFileSync(nodesFile, '{"id":"n_second_torn",');
			assert.ok(fs.statSync(nodesFile).size > originalSize);
			const rebootStore = createGraphStore(graphDir); // Auto-recovers on boot!
			assert.equal(fs.statSync(nodesFile).size, originalSize, "Boot recovery must auto-truncate torn line");
			assert.equal(rebootStore.readNodes().length, 1);
		});

		it("Test 4.4: Programmatic rollback: rollbackGeneration(1) restores generation 1 snapshot and refreshes in-memory store", async () => {
			// Commit 1
			const node1 = makeNode("n_gen1", "Gen 1 statement");
			const ev1 = makeEvidence("ev_gen1", "n_gen1", "doc_1");
			await graphStore.commitGeneration!({
				projectId,
				nodesToAppend: [node1],
				evidenceBatch: [ev1],
			});

			// Commit 2
			const node2 = makeNode("n_gen2", "Gen 2 statement");
			const ev2 = makeEvidence("ev_gen2", "n_gen2", "doc_2");
			await graphStore.commitGeneration!({
				projectId,
				nodesToAppend: [node2],
				evidenceBatch: [ev2],
			});

			// Commit 3
			const node3 = makeNode("n_gen3", "Gen 3 statement");
			const ev3 = makeEvidence("ev_gen3", "n_gen3", "doc_3");
			await graphStore.commitGeneration!({
				projectId,
				nodesToAppend: [node3],
				evidenceBatch: [ev3],
			});

			const gen3 = await graphStore.getGeneration!();
			assert.equal(gen3.generation, 3);
			assert.equal(graphStore.readNodes().length, 3);

			// Roll back to generation 1
			const rolledBack = await graphStore.rollbackGeneration!(1);
			assert.equal(rolledBack.generation, 1);

			// Verify in-memory state is refreshed
			const nodesAfter = graphStore.readNodes();
			assert.equal(nodesAfter.length, 1);
			assert.equal(nodesAfter[0]!.id, "n_gen1");

			const evidenceAfter = await graphStore.readEvidence!();
			assert.equal(evidenceAfter.length, 1);
			assert.equal(evidenceAfter[0]!.id, "ev_gen1");
		});
	});

	// ─── SUITE 5: FULL RECONCILER INTEGRATION (SCENARIOS A–D E2E) ──────────────
	describe("Suite 5: Full Reconciler Integration with Atomic Commits", () => {
		it("Test 5.1: Scenario A unchanged document skip: does not increment generation", async () => {
			const doc: SourceDocument = {
				id: "doc_a",
				sourceId: "src_1",
				vaultId: "v1",
				currentPath: "notes/a.md",
				contentHash: "hash_init",
				revisionId: "rev_1",
				status: "active",
			};

			// Initial reconciliation
			const res1 = await reconcileDocument({
				projectId,
				sourceId: "src_1",
				document: doc,
				extractedPropositions: [{ statement: "Initial proposition" }],
				graphStore,
			});
			assert.equal(res1.status, "applied");
			assert.equal(res1.generation, 1);

			// Repeat with identical document
			const res2 = await reconcileDocument({
				projectId,
				sourceId: "src_1",
				document: doc,
				extractedPropositions: [{ statement: "Initial proposition" }],
				graphStore,
			});
			assert.equal(res2.status, "skipped");
			assert.equal(res2.generation, undefined);

			const currentGen = await graphStore.getGeneration!();
			assert.equal(currentGen.generation, 1, "Generation must remain 1 when skipped");
		});

		it("Test 5.2: Scenario B revision superseding: increments generation atomically", async () => {
			const docV1: SourceDocument = {
				id: "doc_b",
				sourceId: "src_1",
				vaultId: "v1",
				currentPath: "notes/b.md",
				contentHash: "hash_v1",
				revisionId: "rev_v1",
				status: "active",
			};

			await reconcileDocument({
				projectId,
				sourceId: "src_1",
				document: docV1,
				extractedPropositions: [{ statement: "Version 1 statement" }],
				graphStore,
			});

			const docV2: SourceDocument = {
				...docV1,
				contentHash: "hash_v2",
				revisionId: "rev_v2",
			};

			const res2 = await reconcileDocument({
				projectId,
				sourceId: "src_1",
				document: docV2,
				extractedPropositions: [{ statement: "Version 1 statement" }], // Same statement, new revision
				graphStore,
			});

			assert.equal(res2.status, "applied");
			assert.equal(res2.generation, 2);
			assert.equal(res2.stats.evidenceAppended, 1);
			assert.equal(res2.stats.evidenceSuperseded, 1);

			const gen = await graphStore.getGeneration!();
			assert.equal(gen.generation, 2);
		});

		it("Test 5.3: Scenario C shared proposition: deleting 1 document supersedes evidence and increments generation while keeping shared proposition active", async () => {
			const doc1: SourceDocument = {
				id: "doc_c1",
				sourceId: "src_1",
				vaultId: "v1",
				currentPath: "notes/c1.md",
				contentHash: "hash_c1",
				revisionId: "rev_1",
				status: "active",
			};
			const doc2: SourceDocument = {
				id: "doc_c2",
				sourceId: "src_1",
				vaultId: "v1",
				currentPath: "notes/c2.md",
				contentHash: "hash_c2",
				revisionId: "rev_1",
				status: "active",
			};

			const sharedStatement = "Shared Knowledge Proposition";

			await reconcileDocument({
				projectId,
				sourceId: "src_1",
				document: doc1,
				extractedPropositions: [{ statement: sharedStatement }],
				graphStore,
			});

			await reconcileDocument({
				projectId,
				sourceId: "src_1",
				document: doc2,
				extractedPropositions: [{ statement: sharedStatement }],
				graphStore,
			});

			// Delete doc1
			const deletedDoc1: SourceDocument = { ...doc1, status: "missing" };
			const resDelete = await reconcileDocument({
				projectId,
				sourceId: "src_1",
				document: deletedDoc1,
				graphStore,
			});

			assert.equal(resDelete.status, "superseded");
			assert.equal(resDelete.generation, 3);
			assert.equal(resDelete.diagnostics.stillSupportedPropositionIds.length, 1);

			// Proposition is still active and supported by doc2
			const activeEvidence = await graphStore.readEvidence!({ status: "active" });
			assert.equal(activeEvidence.length, 1);
			assert.equal(activeEvidence[0]!.documentId, "doc_c2");
		});

		it("Test 5.4: Scenario D deleted note: supersedes evidence and marks orphaned, leaving learner GraphNodes intact", async () => {
			const doc: SourceDocument = {
				id: "doc_d",
				sourceId: "src_1",
				vaultId: "v1",
				currentPath: "notes/d.md",
				contentHash: "hash_d",
				revisionId: "rev_1",
				status: "active",
			};

			await reconcileDocument({
				projectId,
				sourceId: "src_1",
				document: doc,
				extractedPropositions: [{ statement: "Solo proposition to be orphaned" }],
				graphStore,
			});

			const deletedDoc: SourceDocument = { ...doc, status: "missing" };
			const resDelete = await reconcileDocument({
				projectId,
				sourceId: "src_1",
				document: deletedDoc,
				graphStore,
			});

			assert.equal(resDelete.status, "orphaned");
			assert.equal(resDelete.stats.propositionsOrphaned, 1);

			// GraphNode must NOT be deleted
			const nodes = graphStore.readNodes();
			assert.equal(nodes.length, 1);
			assert.equal(nodes[0]!.statement, "Solo proposition to be orphaned");
		});
	});

	// ─── SUITE 6: PERFORMANCE & LATENCY BENCHMARKING ───────────────────────────
	describe("Suite 6: Performance & Scale Benchmarking", () => {
		it("Test 6.1: 50 sequential commits of propositions complete cleanly", async () => {
			const startTime = Date.now();

			for (let i = 0; i < 50; i++) {
				const node = makeNode(`n_perf_${i}`, `Performance Proposition ${i}`);
				const ev = makeEvidence(`ev_perf_${i}`, `n_perf_${i}`, `doc_perf_${i}`);
				await graphStore.commitGeneration!({
					projectId,
					nodesToAppend: [node],
					evidenceBatch: [ev],
				});
			}

			const duration = Date.now() - startTime;
			const finalGen = await graphStore.getGeneration!();
			assert.equal(finalGen.generation, 50);
			assert.ok(duration < 5000, `50 commits should complete under 5,000ms, took ${duration}ms`);
		});

		it("Test 6.2: Crash recovery check on store boot completes in under 50ms", async () => {
			const startTime = performance.now();
			const report = await recoverGraphStore(graphDir);
			const duration = performance.now() - startTime;

			assert.ok(report.action === "verified" || report.action === "initialized");
			assert.ok(duration < 50, `Crash recovery check should be < 50ms, took ${duration.toFixed(2)}ms`);
		});
	});
});
