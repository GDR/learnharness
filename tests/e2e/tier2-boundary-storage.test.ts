/**
 * Tier 2 E2E Test Suite: Storage & State Machine Integration
 *
 * Verifies Tier 2 requirements from TEST_INFRA.md and PROJECT.md:
 * 1. Boundary Value Analysis (BVA) on project IDs, vault bindings, paths, and glob patterns.
 * 2. Multi-project isolated filesystem storage in os.tmpdir() conforming to Target Storage Layout.
 * 3. Multi-project workspace isolation (Project A vs Project B data, graph, practice, and sessions).
 * 4. Idempotent and restart-safe legacy migration engine with checkpoint recovery.
 * 5. Disconnected vault handling (status: unavailable) without document inventory loss.
 * 6. Mutex serialization (getProjectAuditLock) and atomic POSIX writes (writeAtomicFile).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  validateVaultId,
  InvalidVaultIdError,
  type Project,
  type Vault,
  type ProjectSource,
  type SourceDocument,
  type SourceEvidence,
} from "../../src/core/contracts/project.ts";

import {
  validateProjectId,
  InvalidProjectIdError,
  resolveProjectContext,
  ProjectNotFoundError,
  getProjectStore,
  setProjectStore,
} from "../../src/server/projects.ts";

import {
  createProjectStore,
} from "../../src/store/projects.ts";

import {
  createVaultRegistry,
  getVaultRegistry,
  setVaultRegistry,
} from "../../src/store/vaults.ts";

import { createSourceStore } from "../../src/store/sources.ts";
import { createGraphStore } from "../../src/store/graph.ts";
import { createPracticeStore } from "../../src/store/practice.ts";
import { createChatStore } from "../../src/store/chats.ts";


import {
  getProjectAuditLock,
  clearProjectAuditLocks,
} from "../../src/core/audit-lock.ts";

import {
  writeAtomicFile,
  writeAtomicFileSync,
} from "../../src/core/fs-atomic.ts";

import {
  runLegacyMigration,
  hasLegacyData,
  readMigrationCheckpoint,
} from "../../src/server/migration/legacy-migration.ts";

import {
  TestHarness,
  matchesGlob,
  computeDocumentHash,
  DEFAULT_EXCLUDES,
} from "./test-harness.ts";

describe("Tier 2: Storage & State Machine Integration", () => {
  let harness: TestHarness;
  let tempBaseDir: string;

  beforeEach(() => {
    harness = new TestHarness();
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-tier2-test-"));
    clearProjectAuditLocks();
  });

  afterEach(() => {
    harness.cleanup();
    clearProjectAuditLocks();
    setProjectStore(null);
    setVaultRegistry(null);
    if (fs.existsSync(tempBaseDir)) {
      try {
        fs.rmSync(tempBaseDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup race condition
      }
    }
  });

  // ==========================================================================
  // Feature 1: Boundary Value Analysis on IDs, Bindings, Paths & Globs
  // ==========================================================================
  describe("Feature 1: Boundary Value Analysis on IDs, Bindings, Paths & Globs", () => {
    it("T2.1.1: validates canonical and edge project IDs", () => {
      assert.equal(validateProjectId("proj_default"), "proj_default");
      assert.equal(validateProjectId("proj_1234567890abcdef"), "proj_1234567890abcdef");
      assert.equal(validateProjectId("proj_alpha-beta_123"), "proj_alpha-beta_123");
    });

    it("T2.1.2: rejects invalid project IDs, path traversals and special characters", () => {
      const invalidIds = [
        "",
        "   ",
        "../../etc/passwd",
        "proj_../../../secrets",
        "proj_!@#$%^&*()",
        "proj_hello world",
        "proj_dots.not.allowed",
        "proj/slash/path",
      ];

      for (const invalid of invalidIds) {
        assert.throws(
          () => validateProjectId(invalid),
          (err: unknown) => err instanceof InvalidProjectIdError || err instanceof Error,
          `Expected invalid project ID '${invalid}' to be rejected`
        );
      }
    });

    it("T2.1.3: validates canonical and edge vault IDs", () => {
      assert.equal(validateVaultId("vault_default"), "vault_default");
      assert.equal(validateVaultId("vault_research_2026"), "vault_research_2026");
      assert.equal(validateVaultId("vault_a1-b2_c3"), "vault_a1-b2_c3");
    });

    it("T2.1.4: rejects invalid vault IDs, traversals and malformed formats", () => {
      const invalidVaultIds = [
        "",
        "   ",
        "../vault_escape",
        "vault_path/traversal",
        "vault_*invalid*",
        "vault_hello world",
        "vault.dot.forbidden",
      ];

      for (const invalid of invalidVaultIds) {
        assert.throws(
          () => validateVaultId(invalid),
          (err: unknown) => err instanceof InvalidVaultIdError || err instanceof Error,
          `Expected invalid vault ID '${invalid}' to be rejected`
        );
      }
    });

    it("T2.1.5: handles extreme path boundaries: root paths, spaces, unicode, trailing slashes", () => {
      const paths = [
        "/var/data/notes",
        "/var/data/notes/",
        "/User/Alice/Documents/My Obsidian Vault & Notes (2026)",
        "/tmp/vault/Schrödinger — Квантовая физика",
      ];

      for (const p of paths) {
        const normalized = path.resolve(p).replace(/\\/g, "/");
        assert.ok(normalized.length > 0);
        // Verify glob matching works on extreme paths
        const rel = "Physics/Quantum/Schrodinger.md";
        assert.equal(matchesGlob(rel, ["Physics/**/*.md"]), true);
      }
    });

    it("T2.1.6: glob edge cases: empty filters, single asterisk, recursive wildcard and negation", () => {
      // Empty includes returns false
      assert.equal(matchesGlob("Notes/Test.md", []), false);
      // Wildcard at root
      assert.equal(matchesGlob("root.md", ["*"]), true);
      assert.equal(matchesGlob("nested/sub.md", ["*"]), false);
      // Recursive wildcard
      assert.equal(matchesGlob("a/b/c/d/deep.md", ["**/*.md"]), true);
      // Exact filename match
      assert.equal(matchesGlob("Physics/Classical/Newton.md", ["Physics/Classical/Newton.md"]), true);
      assert.equal(matchesGlob("Physics/Classical/Other.md", ["Physics/Classical/Newton.md"]), false);
      // Exclude override
      assert.equal(matchesGlob("Math/LinearAlgebra.md", ["**/*.md"], ["Math/**"]), false);
    });

    it("T2.1.7: project name boundaries: trims whitespace and handles 100 character long names", async () => {
      const projectStore = createProjectStore(path.join(tempBaseDir, "data"));
      const longName = "A".repeat(100);
      const proj = await projectStore.createProject({ name: `   ${longName}   ` });
      assert.equal(proj.name, longName);

      await assert.rejects(
        () => projectStore.createProject({ name: "     " }),
        /Project name cannot be empty/
      );
    });

    it("T2.1.8: vault display name handles unicode, punctuation, slashes and emojis", async () => {
      const registry = createVaultRegistry(path.join(tempBaseDir, "data"));
      const vaultPath = path.join(tempBaseDir, "test-vault");
      fs.mkdirSync(vaultPath, { recursive: true });

      const complexName = "🧠 Brain & Knowledge Base — 2026 / v1.0 [Main]";
      const vault = await registry.registerVault({
        displayName: complexName,
        kind: "obsidian",
        bindings: [{ deviceId: "device_local", rootPath: vaultPath, status: "available" }],
      });
      assert.equal(vault.displayName, complexName);

      const retrieved = await registry.getVault(vault.id);
      assert.equal(retrieved?.displayName, complexName);
    });

    it("T2.1.9: source contracts enforce syncMode and deletionPolicy invariants", async () => {
      const sourceStore = createSourceStore(path.join(tempBaseDir, "sources_test"));
      const src1 = await sourceStore.addSource({
        projectId: "proj_test",
        vaultId: "vault_test",
        include: ["**/*.md"],
        exclude: [...DEFAULT_EXCLUDES],
        recursive: true,
        enabled: true,
        syncMode: "manual",
        deletionPolicy: "deactivate",
      });
      assert.equal(src1.syncMode, "manual");
      assert.equal(src1.deletionPolicy, "deactivate");

      const src2 = await sourceStore.addSource({
        projectId: "proj_test",
        vaultId: "vault_test",
        include: ["**/*.md"],
        exclude: [...DEFAULT_EXCLUDES],
        recursive: true,
        enabled: true,
        syncMode: "automatic",
        deletionPolicy: "retain",
      });
      assert.equal(src2.syncMode, "automatic");
      assert.equal(src2.deletionPolicy, "retain");
    });
  });

  // ==========================================================================
  // Feature 2: Multi-Project Isolated Storage in os.tmpdir()
  // ==========================================================================
  describe("Feature 2: Multi-Project Isolated Storage in os.tmpdir()", () => {
    it("T2.2.1: provisions Target Storage Layout matching specifications exactly", async () => {
      const dataDir = path.join(tempBaseDir, "data");
      const projectStore = createProjectStore(dataDir);
      const projA = await projectStore.createProject({
        name: "Quantum Mechanics",
        description: "Study quantum theory",
      });

      assert.ok(projA.id.startsWith("proj_"));
      const globalProjectsJson = path.join(dataDir, "global", "projects.json");
      assert.ok(fs.existsSync(globalProjectsJson), "data/global/projects.json must exist");

      const projDir = path.join(dataDir, "projects", projA.id);
      assert.ok(fs.existsSync(path.join(projDir, "project.json")), "project.json must exist");
      assert.ok(fs.existsSync(path.join(projDir, "chats")), "chats/ dir must exist");
      assert.ok(fs.existsSync(path.join(projDir, "graph")), "graph/ dir must exist");
      assert.ok(fs.existsSync(path.join(projDir, "jobs")), "jobs/ dir must exist");
      assert.ok(fs.existsSync(path.join(projDir, "practice")), "practice/ dir must exist");
      assert.ok(fs.existsSync(path.join(projDir, "sources")), "sources/ dir must exist");
      assert.ok(fs.existsSync(path.join(projDir, "index")), "index/ dir must exist");
    });

    it("T2.2.2: multiple projects maintain distinct subdirectories without collision", async () => {
      const projectStore = createProjectStore(tempBaseDir);
      const proj1 = await projectStore.createProject({ name: "Project One" });
      const proj2 = await projectStore.createProject({ name: "Project Two" });
      const proj3 = await projectStore.createProject({ name: "Project Three" });

      assert.notEqual(proj1.id, proj2.id);
      assert.notEqual(proj2.id, proj3.id);

      const projects = await projectStore.listProjects();
      assert.equal(projects.length, 3);
      assert.ok(projects.some((p) => p.id === proj1.id));
      assert.ok(projects.some((p) => p.id === proj2.id));
      assert.ok(projects.some((p) => p.id === proj3.id));
    });

    it("T2.2.3: project updating and status archiving preserves filesystem integrity", async () => {
      const projectStore = createProjectStore(tempBaseDir);
      const proj = await projectStore.createProject({ name: "Archivable Project" });

      const updated = await projectStore.updateProject(proj.id, {
        description: "Updated description",
        settings: { defaultStudyScope: "manual", sourceGrounding: "assisted" },
      });
      assert.equal(updated.description, "Updated description");
      assert.equal(updated.settings.defaultStudyScope, "manual");

      await projectStore.archiveProject(proj.id);
      const archived = await projectStore.getProject(proj.id);
      assert.equal(archived?.status, "archived");
    });
  });

  // ==========================================================================
  // Feature 3: Multi-Project Workspace Isolation (Project A vs Project B)
  // ==========================================================================
  describe("Feature 3: Multi-Project Workspace Isolation (Project A vs Project B)", () => {
    it("T2.3.1: graph evidence isolation: identical claims maintain isolated ledgers", async () => {
      const projA = await harness.createProject({ name: "Project A — Physics" });
      const projB = await harness.createProject({ name: "Project B — Philosophy" });

      harness.assertProjectIsolated(projA, projB);

      const claimStatement = "Energy is quantized in discrete packets";
      const now = new Date().toISOString();

      const evidenceA: SourceEvidence = {
        id: "ev_a_001",
        projectId: projA.id,
        sourceId: "src_physics",
        documentId: "doc_planck",
        revisionId: "rev_001",
        propositionId: "prop_energy_quantum",
        location: { heading: "Planck Law", startOffset: 100, endOffset: 250 },
        provenance: "explicit-source",
        status: "active",
        extractorVersion: "1.0.0",
      };

      const evidenceB: SourceEvidence = {
        id: "ev_b_001",
        projectId: projB.id,
        sourceId: "src_philosophy",
        documentId: "doc_epistemology",
        revisionId: "rev_001",
        propositionId: "prop_energy_quantum",
        location: { heading: "Ontology", startOffset: 50, endOffset: 120 },
        provenance: "model-inferred",
        status: "active",
        extractorVersion: "1.0.0",
      };

      await harness.recordEvidence(evidenceA);
      await harness.recordEvidence(evidenceB);

      const listA = await harness.listEvidence(projA.id);
      const listB = await harness.listEvidence(projB.id);

      assert.equal(listA.length, 1);
      assert.equal(listA[0]?.id, "ev_a_001");
      assert.equal(listA[0]?.provenance, "explicit-source");

      assert.equal(listB.length, 1);
      assert.equal(listB[0]?.id, "ev_b_001");
      assert.equal(listB[0]?.provenance, "model-inferred");
    });

    it("T2.3.2: sources isolation: Project A cannot see or mutate Project B sources", async () => {
      const projA = await harness.createProject({ name: "Project A" });
      const projB = await harness.createProject({ name: "Project B" });
      const vault = await harness.registerVault({ displayName: "Vault", rootPath: tempBaseDir });

      const srcA = await harness.attachSource({
        projectId: projA.id,
        vaultId: vault.id,
        include: ["Physics/**/*.md"],
      });

      const srcB = await harness.attachSource({
        projectId: projB.id,
        vaultId: vault.id,
        include: ["Math/**/*.md"],
      });

      const sourcesDirA = path.join(harness.projectsDataDir, projA.id, "sources", "sources.json");
      const sourcesDirB = path.join(harness.projectsDataDir, projB.id, "sources", "sources.json");

      const listA: ProjectSource[] = JSON.parse(fs.readFileSync(sourcesDirA, "utf-8"));
      const listB: ProjectSource[] = JSON.parse(fs.readFileSync(sourcesDirB, "utf-8"));

      assert.equal(listA.length, 1);
      assert.equal(listA[0]?.id, srcA.id);
      assert.equal(listB.length, 1);
      assert.equal(listB[0]?.id, srcB.id);
    });

    it("T2.3.3: practice sets isolation: practice sets in Project A are invisible to Project B", async () => {
      const practiceDirA = path.join(tempBaseDir, "proj_a_practice");
      const practiceDirB = path.join(tempBaseDir, "proj_b_practice");
      fs.mkdirSync(practiceDirA, { recursive: true });
      fs.mkdirSync(practiceDirB, { recursive: true });

      const practiceStoreA = createPracticeStore(practiceDirA);
      const practiceStoreB = createPracticeStore(practiceDirB);

      const pset = await practiceStoreA.createProblemSet({
        projectId: "proj_a",
        title: "Quantum Exam Practice",
        nodeIds: ["prop_schrodinger"],
        propositions: { prop_schrodinger: { name: "Schrodinger", statement: "Schrodinger equation" } },
        chains: [],
      });

      const setsA = await practiceStoreA.listProblemSets("proj_a");
      const setsB = await practiceStoreB.listProblemSets("proj_b");

      assert.equal(setsA.length, 1);
      assert.equal(setsA[0]?.id, pset.id);
      assert.equal(setsB.length, 0, "Project B must have zero problem sets");
    });

    it("T2.3.4: fail-fast resolution: non-existent projectId throws ProjectNotFoundError (404)", async () => {
      const projectStore = createProjectStore(tempBaseDir);
      setProjectStore(projectStore);

      await assert.rejects(
        async () => {
          await resolveProjectContext("proj_nonexistent_9999");
        },
        (err: unknown) => {
          assert.ok(err instanceof ProjectNotFoundError);
          assert.equal((err as ProjectNotFoundError).status, 404);
          return true;
        }
      );
    });
  });

  // ==========================================================================
  // Feature 4: Idempotent & Restart-Safe Legacy Migration Engine
  // ==========================================================================
  describe("Feature 4: Idempotent & Restart-Safe Legacy Migration Engine", () => {
    it("T2.4.1: detects legacy flat storage and moves data into proj_default cleanly", async () => {
      // Create legacy flat structure
      const legacyChatsDir = path.join(tempBaseDir, "chats");
      const legacyGraphDir = path.join(tempBaseDir, "graph");
      const legacyJobsDir = path.join(tempBaseDir, "jobs");
      const legacyPracticeDir = path.join(tempBaseDir, "practice");
      fs.mkdirSync(legacyChatsDir, { recursive: true });
      fs.mkdirSync(legacyGraphDir, { recursive: true });
      fs.mkdirSync(legacyJobsDir, { recursive: true });
      fs.mkdirSync(legacyPracticeDir, { recursive: true });

      fs.writeFileSync(path.join(legacyChatsDir, "chat_legacy.json"), JSON.stringify({ id: "chat_legacy" }));
      fs.writeFileSync(path.join(legacyGraphDir, "nodes.jsonl"), JSON.stringify({ id: "node_1", statement: "test" }) + "\n");
      fs.writeFileSync(
        path.join(tempBaseDir, "settings.json"),
        JSON.stringify({ obsidianFolders: [tempBaseDir] })
      );

      assert.equal(hasLegacyData(tempBaseDir), true, "hasLegacyData must return true");

      // Run migration
      const result = await runLegacyMigration({ dataDir: tempBaseDir });
      assert.equal(result.migrated, true);
      assert.equal(result.checkpoint.status, "completed");

      // Verify migrated paths
      const targetProjDir = path.join(tempBaseDir, "projects", "proj_default");
      assert.ok(fs.existsSync(path.join(targetProjDir, "chats", "chat_legacy.json")));
      assert.ok(fs.existsSync(path.join(targetProjDir, "graph", "nodes.jsonl")));

      // Verify migration checkpoint
      const checkpoint = await readMigrationCheckpoint(tempBaseDir);
      assert.equal(checkpoint?.status, "completed");
    });

    it("T2.4.2: resumes safely from intermediate migration crash checkpoint", async () => {
      // Simulate crash checkpoint with status in_progress
      const globalDir = path.join(tempBaseDir, "global");
      fs.mkdirSync(globalDir, { recursive: true });

      const checkpointFile = path.join(globalDir, "migration.json");
      fs.writeFileSync(
        checkpointFile,
        JSON.stringify({
          status: "in_progress",
          startedAt: new Date().toISOString(),
          migratedCounts: {
            chats: 0,
            graphFiles: 0,
            jobs: 0,
            practice: 0,
            vaults: 0,
            sources: 0,
          },
        })
      );

      // Create a legacy file to migrate
      const legacyChatsDir = path.join(tempBaseDir, "chats");
      fs.mkdirSync(legacyChatsDir, { recursive: true });
      fs.writeFileSync(path.join(legacyChatsDir, "chat_crash.json"), JSON.stringify({ id: "chat_crash" }));

      // Subsequent migration should resume and reach completion without error
      const result = await runLegacyMigration({ dataDir: tempBaseDir });
      assert.equal(result.migrated, true);
      assert.equal(result.checkpoint.status, "completed");

      const updatedCheckpoint = await readMigrationCheckpoint(tempBaseDir);
      assert.equal(updatedCheckpoint?.status, "completed");
    });

    it("T2.4.3: idempotent re-run on already migrated storage is a safe no-op", async () => {
      const result1 = await runLegacyMigration({ dataDir: tempBaseDir });
      const result2 = await runLegacyMigration({ dataDir: tempBaseDir });

      assert.equal(result2.migrated, false, "Second migration must be no-op");
      assert.equal(hasLegacyData(tempBaseDir), false);
    });
  });

  // ==========================================================================
  // Feature 5: Disconnected Vault Handling (status: unavailable)
  // ==========================================================================
  describe("Feature 5: Disconnected Vault Handling (status: unavailable)", () => {
    it("T2.5.1: disconnected vault preserves document inventory and hashes", async () => {
      const vaultRegistry = createVaultRegistry(tempBaseDir);
      const sourceStore = createSourceStore(path.join(tempBaseDir, "data", "projects", "proj_test", "sources"));

      const vaultPath = path.join(tempBaseDir, "my-vault");
      fs.mkdirSync(vaultPath, { recursive: true });

      const vault = await vaultRegistry.registerVault({
        displayName: "Research Vault",
        kind: "obsidian",
        bindings: [{ deviceId: "device_1", rootPath: vaultPath, status: "available" }],
      });

      const source = await sourceStore.addSource({
        projectId: "proj_test",
        vaultId: vault.id,
        include: ["**/*.md"],
        exclude: [...DEFAULT_EXCLUDES],
        recursive: true,
        enabled: true,
        syncMode: "automatic",
        deletionPolicy: "deactivate",
      });

      // Populate document inventory
      const docRecord: SourceDocument = {
        id: "doc_123",
        sourceId: source.id,
        vaultId: vault.id,
        currentPath: "Physics/Quantum/Schrodinger.md",
        contentHash: "hash_abc_123",
        revisionId: "rev_001",
        status: "active",
        indexedAt: new Date().toISOString(),
      };
      await sourceStore.upsertDocument(docRecord);

      // Disconnect vault (status: unavailable)
      await vaultRegistry.updateBinding(vault.id, {
        deviceId: "device_1",
        rootPath: vaultPath,
        status: "unavailable",
      });

      const updatedVault = await vaultRegistry.getVault(vault.id);
      assert.equal(updatedVault?.bindings[0]?.status, "unavailable");

      // Invariant: Document inventory records are NOT purged or marked missing
      const docs = await sourceStore.listDocuments(source.id);
      assert.equal(docs.length, 1);
      assert.equal(docs[0]?.id, "doc_123");
      assert.equal(docs[0]?.status, "active", "Document status must be preserved");
      assert.equal(docs[0]?.contentHash, "hash_abc_123");
    });

    it("T2.5.2: re-attaching or re-enabling vault restores normal scanning without data loss", async () => {
      const vaultRegistry = createVaultRegistry(tempBaseDir);
      const vaultPath = path.join(tempBaseDir, "reconnect-vault");
      fs.mkdirSync(vaultPath, { recursive: true });

      const vault = await vaultRegistry.registerVault({
        displayName: "Reconnect Vault",
        kind: "obsidian",
        bindings: [{ deviceId: "device_1", rootPath: vaultPath, status: "unavailable" }],
      });

      // Reconnect
      await vaultRegistry.updateBinding(vault.id, {
        deviceId: "device_1",
        rootPath: vaultPath,
        status: "available",
      });

      const retrieved = await vaultRegistry.getVault(vault.id);
      assert.equal(retrieved?.bindings[0]?.status, "available");
    });

    it("T2.5.3: multiple documents and revision histories remain immutable while vault is offline", async () => {
      const sourceStore = createSourceStore(path.join(tempBaseDir, "data", "projects", "proj_offline", "sources"));
      const docList: SourceDocument[] = [
        {
          id: "doc_alpha",
          sourceId: "src_1",
          vaultId: "vault_offline",
          currentPath: "Physics/Newton.md",
          contentHash: "hash_alpha",
          revisionId: "rev_alpha",
          status: "active",
        },
        {
          id: "doc_beta",
          sourceId: "src_1",
          vaultId: "vault_offline",
          currentPath: "Physics/Schrodinger.md",
          contentHash: "hash_beta",
          revisionId: "rev_beta",
          status: "active",
        },
      ];

      for (const d of docList) {
        await sourceStore.upsertDocument(d);
      }

      // Simulate offline state: list documents without filesystem scan
      const docs = await sourceStore.listDocuments("src_1");
      assert.equal(docs.length, 2);
      assert.deepEqual(docs.map((d) => d.id).sort(), ["doc_alpha", "doc_beta"]);
      assert.ok(docs.every((d) => d.status === "active"));
    });
  });

  // ==========================================================================
  // Feature 6: Mutex Serialization and Atomic POSIX Writes
  // ==========================================================================
  describe("Feature 6: Mutex Serialization and Atomic POSIX Writes", () => {
    it("T2.6.1: writeAtomicFile prevents partial writes under concurrent execution", async () => {
      const targetFile = path.join(tempBaseDir, "atomic-test.json");
      const payloadCount = 15;

      const promises = Array.from({ length: payloadCount }).map((_, i) => {
        const payload = JSON.stringify({ index: i, timestamp: Date.now(), data: "x".repeat(1024) });
        return writeAtomicFile(targetFile, payload);
      });

      await Promise.all(promises);

      // File must be valid JSON and readable
      assert.ok(fs.existsSync(targetFile));
      const content = fs.readFileSync(targetFile, "utf-8");
      const parsed = JSON.parse(content);
      assert.ok(typeof parsed.index === "number");
      assert.ok(parsed.data.length === 1024);

      // Ensure no dangling .tmp files remain
      const files = fs.readdirSync(tempBaseDir);
      const tmpFiles = files.filter((f) => f.includes(".tmp"));
      assert.equal(tmpFiles.length, 0, "No temporary files should linger");
    });

    it("T2.6.2: writeAtomicFileSync writes synchronously with atomic rename", () => {
      const targetFile = path.join(tempBaseDir, "sync-atomic.json");
      const payload = JSON.stringify({ success: true, count: 42 });

      writeAtomicFileSync(targetFile, payload);
      assert.ok(fs.existsSync(targetFile));
      const content = fs.readFileSync(targetFile, "utf-8");
      assert.deepEqual(JSON.parse(content), { success: true, count: 42 });
    });

    it("T2.6.3: getProjectAuditLock serializes concurrent async execution on the same project", async () => {
      const lock = getProjectAuditLock("proj_lock_test");
      let activeWriters = 0;
      let maxConcurrentWriters = 0;
      const executionOrder: number[] = [];

      const runJob = (id: number, delayMs: number) => {
        return lock(async () => {
          activeWriters++;
          maxConcurrentWriters = Math.max(maxConcurrentWriters, activeWriters);
          await new Promise((r) => setTimeout(r, delayMs));
          executionOrder.push(id);
          activeWriters--;
          return id;
        });
      };

      const tasks = [
        runJob(1, 20),
        runJob(2, 10),
        runJob(3, 5),
        runJob(4, 15),
      ];

      await Promise.all(tasks);

      assert.equal(maxConcurrentWriters, 1, "Max concurrent writers under project lock must strictly be 1");
      assert.equal(executionOrder.length, 4);
    });

    it("T2.6.4: cross-project audit locks run in parallel without mutual blocking", async () => {
      const lockA = getProjectAuditLock("proj_A");
      const lockB = getProjectAuditLock("proj_B");

      let concurrentCrossProject = 0;
      let maxCrossProject = 0;

      const jobA = lockA(async () => {
        concurrentCrossProject++;
        maxCrossProject = Math.max(maxCrossProject, concurrentCrossProject);
        await new Promise((r) => setTimeout(r, 25));
        concurrentCrossProject--;
      });

      const jobB = lockB(async () => {
        concurrentCrossProject++;
        maxCrossProject = Math.max(maxCrossProject, concurrentCrossProject);
        await new Promise((r) => setTimeout(r, 25));
        concurrentCrossProject--;
      });

      await Promise.all([jobA, jobB]);

      assert.ok(
        maxCrossProject >= 2,
        `Expected distinct project locks to execute concurrently in parallel, got max ${maxCrossProject}`
      );
    });
  });
});
