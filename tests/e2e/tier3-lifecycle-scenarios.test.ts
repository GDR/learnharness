/**
 * Tier 3 E2E Test Suite: In-Process Full Lifecycle Scenarios A–F
 *
 * Verifies Tier 3 In-Process Full Lifecycle Invariants against Fixture Vault:
 * - Scenario A: Unchanged document scan -> 0 duplicate evidence, zero writes.
 * - Scenario B: Note modification in sandbox -> new revision, prior marked superseded.
 * - Scenario C: Shared proposition co-supported by 2 notes -> deleting 1 note deactivates its evidence while proposition remains active.
 * - Scenario D: Learner understanding observation & practice set preservation after note deletion.
 * - Scenario E: Concurrent indexing serialization via generation locks and project mutex.
 * - Scenario F: Simulated crash/interruption recovery without ledger corruption.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  TestHarness,
  computeDocumentHash,
  type SourceEvidence,
  type SourceDocument,
  type Project,
  type Vault,
  type ProjectSource,
} from "./test-harness.ts";

import {
  computeReconciliationPlan,
  applyReconciliationPlan,
  matchPropositionToNode,
  newGraphNodeId,
  newEvidenceId,
  type ComputePlanInput,
} from "../../src/server/indexing/reconciler.ts";

import { createGraphStore } from "../../src/store/graph.ts";
import { createPracticeStore } from "../../src/store/practice.ts";
import type { GraphStore, PracticeStore } from "../../src/core/ports.ts";
import type { GraphNode } from "../../src/core/contracts/graph.ts";
import type { ExtractedPropositionInput } from "../../src/core/contracts/reconciler.ts";
import { clearProjectAuditLocks, getProjectAuditLock } from "../../src/core/audit-lock.ts";

import {
  executeGenerationCommit,
  recoverGraphStore,
  computeLedgerSnapshot,
  hasTornTail,
  getProjectGeneration,
} from "../../src/store/graph-generation.ts";

import { GenerationConflictError } from "../../src/core/contracts/generation.ts";

async function readStoreEvidence(store: GraphStore): Promise<SourceEvidence[]> {
  if (!store.readEvidence) return [];
  return (await store.readEvidence()) as SourceEvidence[];
}

describe("Tier 3: In-Process Full Lifecycle Scenarios A–F", () => {
  let harness: TestHarness;
  let sandbox: { vaultPath: string; cleanup: () => void };
  let tempStorageDir: string;
  let graphStore: GraphStore;
  let practiceStore: PracticeStore;
  let graphDir: string;
  let practiceDir: string;

  const projectId = "proj_lifecycle_e2e";
  const sourceId = "src_obsidian_notes";
  const vaultId = "vault_sandbox_fixture";

  beforeEach(() => {
    harness = new TestHarness();
    sandbox = harness.createSandboxVault();

    tempStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-tier3-storage-"));
    graphDir = path.join(tempStorageDir, "data", "projects", projectId, "graph");
    practiceDir = path.join(tempStorageDir, "data", "projects", projectId, "practice");

    fs.mkdirSync(graphDir, { recursive: true });
    fs.mkdirSync(practiceDir, { recursive: true });

    graphStore = createGraphStore(graphDir);
    practiceStore = createPracticeStore(practiceDir);
    clearProjectAuditLocks();
  });

  afterEach(() => {
    sandbox.cleanup();
    harness.cleanup();
    clearProjectAuditLocks();
    if (fs.existsSync(tempStorageDir)) {
      try {
        fs.rmSync(tempStorageDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup race conditions
      }
    }
  });

  // ==========================================================================
  // Scenario A: Unchanged Document Scan -> 0 Duplicate Evidence
  // ==========================================================================
  describe("Scenario A: Unchanged Document Scan (Idempotency Invariant)", () => {
    it("T3.1.1: scanning unchanged fixture vault produces identical content hashes and skips redundant extraction", async () => {
      const schrodingerPath = path.join(sandbox.vaultPath, "Physics", "Quantum", "Schrodinger.md");
      assert.ok(fs.existsSync(schrodingerPath), "Schrodinger.md must exist in sandbox vault");

      const content1 = fs.readFileSync(schrodingerPath);
      const hash1 = computeDocumentHash(content1);
      const revId1 = `rev_${hash1.slice(0, 8)}`;

      const docRecord: SourceDocument = {
        id: "doc_schrodinger",
        sourceId,
        vaultId,
        currentPath: "Physics/Quantum/Schrodinger.md",
        contentHash: hash1,
        revisionId: revId1,
        status: "active",
        indexedAt: new Date().toISOString(),
      };

      const extractedPropositions: ExtractedPropositionInput[] = [
        {
          statement: "The time-dependent Schrödinger equation governs quantum state evolution",
          name: "Schrödinger Equation",
          heading: "The Time-Dependent Schrödinger Equation",
          provenance: "explicit-source",
        },
      ];

      // Initial reconciliation & commit
      const initialPlan = computeReconciliationPlan({
        projectId,
        sourceId,
        document: docRecord,
        extractedPropositions,
        existingEvidence: [],
        existingNodes: [],
      });

      assert.equal(initialPlan.scenario, "B_MODIFIED"); // New doc treated as initial version
      assert.equal(initialPlan.nodesToAppend.length, 1);
      assert.equal(initialPlan.evidenceToAppend.length, 1);

      await applyReconciliationPlan(initialPlan, { graphStore, projectId });

      const nodesAfter1 = graphStore.readNodes();
      const evidenceAfter1 = await harness.listEvidence(projectId);
      assert.equal(nodesAfter1.length, 1);

      // Re-scan without any modification to Schrodinger.md
      const content2 = fs.readFileSync(schrodingerPath);
      const hash2 = computeDocumentHash(content2);
      assert.equal(hash1, hash2, "Hashes must be identical on unchanged document");

      const existingEvidence = await readStoreEvidence(graphStore);
      const existingNodes = graphStore.readNodes();

      const secondPlan = computeReconciliationPlan({
        projectId,
        sourceId,
        document: docRecord,
        extractedPropositions,
        existingEvidence,
        existingNodes,
      });

      // INVARIANT: Scenario A must be selected
      assert.equal(secondPlan.scenario, "A_UNCHANGED");
      assert.equal(secondPlan.evidenceToAppend.length, 0, "Zero new evidence to append");
      assert.equal(secondPlan.evidenceToSupersede.length, 0, "Zero evidence to supersede");
      assert.equal(secondPlan.nodesToAppend.length, 0, "Zero new nodes to append");
      assert.equal(secondPlan.unchangedEvidenceCount, 1);

      // Apply second plan -> zero writes
      const res = await applyReconciliationPlan(secondPlan, { graphStore, projectId });
      assert.equal(res.status, "skipped");
      assert.equal(res.stats.evidenceAppended, 0);
      assert.equal(res.stats.evidenceSuperseded, 0);
      assert.equal(res.stats.propositionsCreated, 0);

      // Final evidence ledger check
      const finalEvidence = await readStoreEvidence(graphStore);
      assert.equal(finalEvidence.length, 1);
      harness.assertZeroDuplicateEvidence(finalEvidence);
    });
  });

  // ==========================================================================
  // Scenario B: Note Modification -> New Revision, Prior Marked Superseded
  // ==========================================================================
  describe("Scenario B: Note Modification (Revision Superseding Invariant)", () => {
    it("T3.2.1: modifying note in sandbox creates new revision, extracts updated evidence and supersedes prior revision", async () => {
      const schrodingerPath = path.join(sandbox.vaultPath, "Physics", "Quantum", "Schrodinger.md");
      const initialContent = fs.readFileSync(schrodingerPath, "utf-8");
      const hashV1 = computeDocumentHash(initialContent);
      const revV1 = `rev_${hashV1.slice(0, 8)}`;

      const docV1: SourceDocument = {
        id: "doc_schrodinger",
        sourceId,
        vaultId,
        currentPath: "Physics/Quantum/Schrodinger.md",
        contentHash: hashV1,
        revisionId: revV1,
        status: "active",
      };

      const propV1: ExtractedPropositionInput = {
        statement: "The time-dependent Schrödinger equation: i hbar d/dt psi = H psi",
        heading: "Equation",
        provenance: "explicit-source",
      };

      // Ingest Revision 1
      const planV1 = computeReconciliationPlan({
        projectId,
        sourceId,
        document: docV1,
        extractedPropositions: [propV1],
        existingEvidence: [],
        existingNodes: [],
      });
      await applyReconciliationPlan(planV1, { graphStore, projectId });

      const evidenceV1 = (await readStoreEvidence(graphStore)).find((e) => e.revisionId === revV1);
      assert.ok(evidenceV1);
      harness.assertEvidenceActive(evidenceV1);

      // In sandbox: edit note text (add relativistic statement)
      const modifiedContent = initialContent + "\n\nNote: In relativistic quantum mechanics, Dirac equation replaces Schrödinger.\n";
      fs.writeFileSync(schrodingerPath, modifiedContent, "utf-8");

      const hashV2 = computeDocumentHash(modifiedContent);
      assert.notEqual(hashV1, hashV2, "Hash must change after editing");
      const revV2 = `rev_${hashV2.slice(0, 8)}`;

      const docV2: SourceDocument = {
        id: "doc_schrodinger",
        sourceId,
        vaultId,
        currentPath: "Physics/Quantum/Schrodinger.md",
        contentHash: hashV2,
        revisionId: revV2,
        status: "active",
      };

      const propV2: ExtractedPropositionInput = {
        statement: "The time-dependent Schrödinger equation: i hbar d/dt psi = H psi",
        heading: "Equation",
        provenance: "explicit-source",
      };

      const existingEvidence = await readStoreEvidence(graphStore);
      const existingNodes = graphStore.readNodes();

      const planV2 = computeReconciliationPlan({
        projectId,
        sourceId,
        document: docV2,
        extractedPropositions: [propV2],
        existingEvidence,
        existingNodes,
      });

      // INVARIANT: Scenario B must be selected
      assert.equal(planV2.scenario, "B_MODIFIED");
      assert.equal(planV2.evidenceToSupersede.length, 1);
      assert.equal(planV2.evidenceToSupersede[0]?.id, evidenceV1.id);
      assert.equal(planV2.evidenceToAppend.length, 1);
      assert.equal(planV2.evidenceToAppend[0]?.revisionId, revV2);

      await applyReconciliationPlan(planV2, { graphStore, projectId });

      // Invariant assertions
      const allEvidence = await readStoreEvidence(graphStore);
      assert.equal(allEvidence.length, 2);

      const oldEv = allEvidence.find((e) => e.revisionId === revV1);
      const newEv = allEvidence.find((e) => e.revisionId === revV2);

      assert.ok(oldEv && newEv);
      harness.assertEvidenceSuperseded(oldEv);
      harness.assertEvidenceActive(newEv);
      assert.equal(oldEv.propositionId, newEv.propositionId, "Both revisions reference the same proposition");
    });
  });

  // ==========================================================================
  // Scenario C: Shared Proposition Co-Supported by 2 Notes
  // ==========================================================================
  describe("Scenario C: Shared Proposition Co-Supported by 2 Notes", () => {
    it("T3.3.1: deleting 1 note deactivates its evidence while proposition remains active because 2nd note supports it", async () => {
      const pathA = path.join(sandbox.vaultPath, "Shared", "EnergyQuantizationA.md");
      const pathB = path.join(sandbox.vaultPath, "Shared", "EnergyQuantizationB.md");
      assert.ok(fs.existsSync(pathA) && fs.existsSync(pathB));

      const hashA = computeDocumentHash(fs.readFileSync(pathA));
      const hashB = computeDocumentHash(fs.readFileSync(pathB));

      const docA: SourceDocument = {
        id: "doc_energy_a",
        sourceId,
        vaultId,
        currentPath: "Shared/EnergyQuantizationA.md",
        contentHash: hashA,
        revisionId: `rev_${hashA.slice(0, 8)}`,
        status: "active",
      };

      const docB: SourceDocument = {
        id: "doc_energy_b",
        sourceId,
        vaultId,
        currentPath: "Shared/EnergyQuantizationB.md",
        contentHash: hashB,
        revisionId: `rev_${hashB.slice(0, 8)}`,
        status: "active",
      };

      const sharedStatement = "Energy is emitted and absorbed in discrete packets called quanta";

      // 1. Ingest Note A
      const planA = computeReconciliationPlan({
        projectId,
        sourceId,
        document: docA,
        extractedPropositions: [{ statement: sharedStatement, heading: "Planck Quanta" }],
        existingEvidence: [],
        existingNodes: [],
      });
      await applyReconciliationPlan(planA, { graphStore, projectId });

      const nodesAfterA = graphStore.readNodes();
      assert.equal(nodesAfterA.length, 1);
      const sharedNodeId = nodesAfterA[0]?.id;
      assert.ok(sharedNodeId);

      // 2. Ingest Note B (references same statement)
      const existingEvA = await readStoreEvidence(graphStore);
      const planB = computeReconciliationPlan({
        projectId,
        sourceId,
        document: docB,
        extractedPropositions: [{ statement: sharedStatement, heading: "Bohr Orbits" }],
        existingEvidence: existingEvA,
        existingNodes: nodesAfterA,
        allActiveEvidence: existingEvA,
      });

      assert.equal(planB.scenario, "C_SHARED");
      assert.equal(planB.reusedPropositionIds[0], sharedNodeId);
      assert.equal(planB.nodesToAppend.length, 0, "No duplicate node should be created");
      await applyReconciliationPlan(planB, { graphStore, projectId });

      const evidenceBoth = await readStoreEvidence(graphStore);
      assert.equal(evidenceBoth.length, 2);
      assert.ok(evidenceBoth.every((e) => e.propositionId === sharedNodeId && e.status === "active"));

      // 3. Delete Note A from sandbox vault
      fs.unlinkSync(pathA);
      assert.equal(fs.existsSync(pathA), false);

      const docADeleted: SourceDocument = {
        ...docA,
        status: "missing",
      };

      const planDeleteA = computeReconciliationPlan({
        projectId,
        sourceId,
        document: docADeleted,
        existingEvidence: await readStoreEvidence(graphStore),
        existingNodes: graphStore.readNodes(),
        allActiveEvidence: (await readStoreEvidence(graphStore)).filter((e) => e.status === "active"),
      });

      assert.equal(planDeleteA.scenario, "D_DELETED");
      assert.equal(planDeleteA.evidenceToSupersede.length, 1);
      assert.equal(planDeleteA.stillSupportedPropositionIds[0], sharedNodeId);
      assert.equal(planDeleteA.orphanedPropositionIds.length, 0);

      await applyReconciliationPlan(planDeleteA, { graphStore, projectId });

      // INVARIANT: Node remains in graph, Doc A evidence superseded, Doc B evidence active
      const finalNodes = graphStore.readNodes();
      assert.equal(finalNodes.length, 1);
      assert.equal(finalNodes[0]?.id, sharedNodeId);

      const finalEvidence = await readStoreEvidence(graphStore);
      const evA = finalEvidence.find((e) => e.documentId === docA.id);
      const evB = finalEvidence.find((e) => e.documentId === docB.id);

      assert.ok(evA && evB);
      harness.assertEvidenceSuperseded(evA);
      harness.assertEvidenceActive(evB);
    });
  });

  // ==========================================================================
  // Scenario D: Learner Concept & Practice Set Preservation
  // ==========================================================================
  describe("Scenario D: Learner Concept & Practice Set Preservation", () => {
    it("T3.4.1: deleting source note deactivates source evidence but preserves learner graph node and practice sets", async () => {
      const linearAlgebraPath = path.join(sandbox.vaultPath, "Math", "LinearAlgebra.md");
      const content = fs.readFileSync(linearAlgebraPath);
      const hash = computeDocumentHash(content);

      const docRecord: SourceDocument = {
        id: "doc_linear_algebra",
        sourceId,
        vaultId,
        currentPath: "Math/LinearAlgebra.md",
        contentHash: hash,
        revisionId: `rev_${hash.slice(0, 8)}`,
        status: "active",
      };

      const eigenStatement = "Eigenvalues lambda satisfy det(A - lambda I) = 0";

      // 1. Ingest note
      const plan = computeReconciliationPlan({
        projectId,
        sourceId,
        document: docRecord,
        extractedPropositions: [{ statement: eigenStatement, heading: "Eigenvalues" }],
        existingEvidence: [],
        existingNodes: [],
      });
      await applyReconciliationPlan(plan, { graphStore, projectId });

      const nodes = graphStore.readNodes();
      assert.equal(nodes.length, 1);
      const eigenNodeId = nodes[0]?.id;
      assert.ok(eigenNodeId);

      // 2. Learner engages with this topic: create problem set in PracticeStore
      const problemSet = await practiceStore.createProblemSet({
        projectId,
        title: "Eigenvalues and Linear Transformations Review",
        nodeIds: [eigenNodeId],
        propositions: { [eigenNodeId]: { name: "Eigenvalues", statement: eigenStatement } },
        chains: [],
      });
      assert.ok(problemSet.id.startsWith("pset_"));

      // 3. Delete LinearAlgebra.md from sandbox vault
      fs.unlinkSync(linearAlgebraPath);

      const deletedDoc: SourceDocument = {
        ...docRecord,
        status: "missing",
      };

      const planDelete = computeReconciliationPlan({
        projectId,
        sourceId,
        document: deletedDoc,
        existingEvidence: await readStoreEvidence(graphStore),
        existingNodes: graphStore.readNodes(),
        options: { deletionPolicy: "deactivate" },
      });

      await applyReconciliationPlan(planDelete, { graphStore, projectId });

      // INVARIANT: Source evidence is superseded
      const evidence = await readStoreEvidence(graphStore);
      assert.equal(evidence.length, 1);
      harness.assertEvidenceSuperseded(evidence[0]!);

      // INVARIANT: Learner node is preserved in GraphStore
      const nodesAfterDelete = graphStore.readNodes();
      assert.equal(nodesAfterDelete.length, 1);
      assert.equal(nodesAfterDelete[0]?.id, eigenNodeId);

      // INVARIANT: Practice problem set remains 100% intact
      const psets = await practiceStore.listProblemSets(projectId);
      assert.equal(psets.length, 1);
      assert.equal(psets[0]?.id, problemSet.id);
      assert.equal(psets[0]?.nodeIds[0], eigenNodeId);
    });
  });

  // ==========================================================================
  // Scenario E: Concurrent Indexing Serialization via Generation Locks
  // ==========================================================================
  describe("Scenario E: Concurrent Indexing Serialization", () => {
    it("T3.5.1: concurrent commits to the same project are serialized by generation locks with monotonic counters", async () => {
      const commitCount = 6;
      const initialGen = await getProjectGeneration(graphDir, projectId);
      assert.equal(initialGen.generation, 0);

      const runConcurrentCommit = async (idx: number) => {
        const lock = getProjectAuditLock(projectId);
        return lock(async () => {
          const current = await getProjectGeneration(graphDir, projectId);
          const node: GraphNode = {
            id: `node_gen_${idx}`,
            name: `Proposition ${idx}`,
            statement: `Concurrent proposition number ${idx} in quantum mechanics`,
            aliases: [],
            createdAt: new Date().toISOString(),
            provenance: [{ chatId: "src_1", messageId: `msg_${idx}` }],
          };

          const evidence: SourceEvidence = {
            id: `ev_gen_${idx}`,
            projectId,
            sourceId: "src_1",
            documentId: `doc_${idx}`,
            revisionId: `rev_${idx}`,
            propositionId: node.id,
            provenance: "explicit-source",
            status: "active",
            extractorVersion: "1.0.0",
          };

          return executeGenerationCommit(graphDir, {
            projectId,
            baseGeneration: current.generation,
            nodesToAppend: [node],
            evidenceBatch: [evidence],
          });
        });
      };

      const tasks = Array.from({ length: commitCount }).map((_, i) => runConcurrentCommit(i + 1));
      const results = await Promise.all(tasks);

      assert.equal(results.length, commitCount);

      // Invariant: generation numbers are strictly monotonic (1 to commitCount)
      const finalGen = await getProjectGeneration(graphDir, projectId);
      assert.equal(finalGen.generation, commitCount);

      // Verify ledgers on disk
      const nodesOnDisk = graphStore.readNodes();
      assert.equal(nodesOnDisk.length, commitCount);

      const snapshot = computeLedgerSnapshot(path.join(graphDir, "nodes.jsonl"));
      assert.equal(snapshot.lineCount, commitCount);
    });

    it("T3.5.2: rejects stale baseGeneration with GenerationConflictError (optimistic concurrency)", async () => {
      const genRecord = await getProjectGeneration(graphDir, projectId);

      // Attempt commit with outdated baseGeneration
      await assert.rejects(
        () =>
          executeGenerationCommit(graphDir, {
            projectId,
            baseGeneration: genRecord.generation + 99, // Stale generation
            nodesToAppend: [],
            evidenceBatch: [],
          }),
        (err: unknown) => err instanceof GenerationConflictError
      );
    });
  });

  // ==========================================================================
  // Scenario F: Interrupted Commit / Crash Recovery
  // ==========================================================================
  describe("Scenario F: Interrupted Commit / Crash Recovery", () => {
    it("T3.6.1: recoverGraphStore repairs uncommitted staging artifacts and restores consistent ledger state", async () => {
      // 1. Establish valid baseline commit
      const baseNode: GraphNode = {
        id: "node_valid_1",
        name: "Valid Node",
        statement: "Valid baseline proposition that was committed successfully",
        aliases: [],
        createdAt: new Date().toISOString(),
        provenance: [],
      };
      await executeGenerationCommit(graphDir, {
        projectId,
        nodesToAppend: [baseNode],
        evidenceBatch: [],
      });

      const genBefore = await getProjectGeneration(graphDir, projectId);
      assert.equal(genBefore.generation, 1);

      // 2. Simulate crash: inject orphaned uncommitted staging folder with broken temporary files
      const stagingDir = path.join(graphDir, ".staging", "gen-2");
      fs.mkdirSync(stagingDir, { recursive: true });
      fs.writeFileSync(path.join(stagingDir, "nodes.jsonl.tmp"), '{"corrupt": true, incomplete');
      fs.writeFileSync(path.join(stagingDir, "journal.json"), '{"targetGeneration": 2, "status": "staged"}');

      // 3. Append torn trailing bytes to nodes.jsonl
      const nodesFile = path.join(graphDir, "nodes.jsonl");
      fs.appendFileSync(nodesFile, '{"id": "node_torn_uncommitted", "statement": "torn'); // Incomplete JSON line

      assert.equal(hasTornTail(nodesFile, genBefore.snapshots.nodes.byteOffset), true);

      // 4. Run recovery engine
      const report = await recoverGraphStore(graphDir);
      assert.ok(report.action === "repaired" || report.action === "rolled_back" || report.action === "verified");

      // INVARIANT: Ledger is restored, corrupt staging cleaned up
      assert.equal(fs.existsSync(stagingDir), false, ".staging dir must be purged");

      const nodesAfter = graphStore.readNodes();
      assert.equal(nodesAfter.length, 1);
      assert.equal(nodesAfter[0]?.id, "node_valid_1");

      // Verify subsequent commits succeed cleanly
      const nextNode: GraphNode = {
        id: "node_valid_2",
        name: "Second Node",
        statement: "Second proposition committed after successful crash recovery",
        aliases: [],
        createdAt: new Date().toISOString(),
        provenance: [],
      };
      const resultAfterRecovery = await executeGenerationCommit(graphDir, {
        projectId,
        nodesToAppend: [nextNode],
        evidenceBatch: [],
      });
      assert.equal(resultAfterRecovery.generation, 2);
    });
  });
});
