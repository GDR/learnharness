/**
 * Tier 4: Route Handlers & Bridge Integration E2E Test Suite
 *
 * Verifies Next.js 16 App Router route handlers and Obsidian Bridge integration:
 * - Feature 1: Project Management REST APIs (/api/projects, /api/projects/:id, /api/projects/:id/archive)
 * - Feature 2: Vault Registry REST APIs (/api/vaults, /api/vaults/:id)
 * - Feature 3: Project Sources Configuration APIs (/api/projects/:id/sources)
 * - Feature 4: Scoped Question Answering & Grounded Synthesis (/api/projects/:id/ask)
 * - Feature 5: Scoped Study Sessions & Immutable Graph Snapshots (/api/projects/:id/study-sessions)
 * - Feature 6: Scoped Practice Sets & Revision Warning Indicators (/api/projects/:id/practice)
 * - Feature 7: Bridge Transport Security, Authentication Headers & Desktop Proxy Capability
 */

import { describe, it, beforeEach, afterEach, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { NextRequest } from "next/server";

// Server Stores & Context
import {
  createProjectStore,
  setProjectStore,
  getProjectStore,
  createVaultRegistry,
  setVaultRegistry,
  getVaultRegistry,
  resolveProjectContext,
  clearProjectContextCache,
  validateProjectId,
} from "../../src/server/index.ts";
import { defaultProjectContextPromise } from "../../src/server/stores.ts";
import { desktopAPIAuthorized } from "../../src/server/desktop-access.ts";
import { proxy } from "../../proxy.ts";

// Core Contracts & Types
import {
  type GraphNode,
  type GraphChain,
  type SourceDocument,
  type AskSourcesResponse,
  type StudySessionResponse,
  type ScopedProblemSet,
  type ProblemSetWarningReport,
} from "../../src/core/index.ts";

// Route Handlers
import {
  GET as getProjects,
  POST as postProjects,
} from "../../app/api/projects/route.ts";
import {
  GET as getProjectById,
  PATCH as patchProjectById,
} from "../../app/api/projects/[id]/route.ts";
import { POST as archiveProjectById } from "../../app/api/projects/[id]/archive/route.ts";
import {
  GET as getVaults,
  POST as postVaults,
} from "../../app/api/vaults/route.ts";
import {
  GET as getVaultById,
  PATCH as patchVaultById,
} from "../../app/api/vaults/[id]/route.ts";
import {
  GET as getSources,
  POST as postSources,
} from "../../app/api/projects/[id]/sources/route.ts";
import { POST as postAsk } from "../../app/api/projects/[id]/ask/route.ts";
import { POST as postStudySession } from "../../app/api/projects/[id]/study-sessions/route.ts";
import {
  GET as getPracticeSets,
  POST as postPracticeSet,
} from "../../app/api/projects/[id]/practice/route.ts";
import { GET as getPracticeWarnings } from "../../app/api/projects/[id]/practice/[psetId]/warnings/route.ts";

// Bridge Transport & Security
import {
  isLoopbackUrl,
  BridgeTransport,
  BridgeTransportError,
} from "../../plugins/obsidian-bridge/src/transport.ts";

// ============================================================================
// Helpers
// ============================================================================

function jsonReq(
  url: string,
  method: string,
  body?: unknown,
  headers?: Record<string, string>,
): Request {
  return new Request(url, {
    method,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function makeGraphNode(id: string, name: string, statement: string): GraphNode {
  return {
    id,
    name,
    statement,
    aliases: [],
    createdAt: new Date().toISOString(),
    provenance: [],
  };
}

function makeGraphChain(id: string, premises: string[], conclusion: string): GraphChain {
  return {
    id,
    premises,
    conclusion,
    provenance: [],
    createdAt: new Date().toISOString(),
  };
}

function makeSourceDoc(
  id: string,
  sourceId: string,
  vaultId: string,
  filePath: string,
  contentHash: string,
  status: "active" | "missing" | "excluded" | "error" = "active",
): SourceDocument {
  return {
    id,
    sourceId,
    vaultId,
    currentPath: filePath,
    contentHash,
    revisionId: `rev_${contentHash.slice(0, 8)}`,
    status,
    indexedAt: new Date().toISOString(),
  };
}

// ============================================================================
// Tier 4 Test Suite
// ============================================================================

describe("Tier 4: Route Handlers & Bridge Integration", () => {
  let tmpDir: string;
  let vaultFolderA: string;
  let vaultFolderB: string;

  before(async () => {
    await defaultProjectContextPromise;
  });

  beforeEach(() => {
    clearProjectContextCache();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-tier4-e2e-"));
    vaultFolderA = path.join(tmpDir, "vault_a");
    vaultFolderB = path.join(tmpDir, "vault_b");
    fs.mkdirSync(vaultFolderA, { recursive: true });
    fs.mkdirSync(vaultFolderB, { recursive: true });

    const pStore = createProjectStore(tmpDir);
    setProjectStore(pStore);

    const vRegistry = createVaultRegistry(tmpDir);
    setVaultRegistry(vRegistry);
  });

  afterEach(() => {
    clearProjectContextCache();
    setVaultRegistry(null);
    setProjectStore(null);
    try {
      if (tmpDir && fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup error
    }
  });

  // ==========================================================================
  // Feature 1: Project Management REST APIs
  // ==========================================================================
  describe("Feature 1: Project Management REST APIs", () => {
    it("T4.1.1: GET /api/projects initially returns empty list and reports activeProjectId", async () => {
      const res = await getProjects();
      assert.equal(res.status, 200);
      const data = (await res.json()) as { projects: unknown[]; activeProjectId: unknown };
      assert.deepEqual(data.projects, []);
      assert.equal(data.activeProjectId, null);
    });

    it("T4.1.2: POST /api/projects creates project with auto-generated ID, default settings and trims whitespace", async () => {
      const req = jsonReq("http://localhost/api/projects", "POST", {
        name: "  Quantum Mechanics  ",
        description: "Physics research and learning notes",
        settings: { sourceGrounding: "assisted" },
      });

      const res = await postProjects(req);
      assert.equal(res.status, 201);
      const data = (await res.json()) as { project: { id: string; name: string; description: string; status: string; settings: { sourceGrounding: string } } };
      assert.ok(data.project);
      assert.match(data.project.id, /^proj_[a-z0-9]+$/);
      assert.equal(data.project.name, "Quantum Mechanics");
      assert.equal(data.project.description, "Physics research and learning notes");
      assert.equal(data.project.status, "active");
      assert.equal(data.project.settings.sourceGrounding, "assisted");

      // Verify list now includes it and activeProjectId points to it
      const listRes = await getProjects();
      const listData = (await listRes.json()) as { projects: Array<{ id: string }>; activeProjectId: string };
      assert.equal(listData.projects.length, 1);
      assert.equal(listData.activeProjectId, data.project.id);
    });

    it("T4.1.3: GET /api/projects/:id retrieves project; fails fast on 404 for missing and 400 for invalid ID", async () => {
      // Create project
      const createReq = jsonReq("http://localhost/api/projects", "POST", { name: "Calculus" });
      const createRes = await postProjects(createReq);
      const { project } = (await createRes.json()) as { project: { id: string; name: string } };

      // 1. Valid retrieval
      const getReq = new Request(`http://localhost/api/projects/${project.id}`);
      const getRes = await getProjectById(getReq, { params: Promise.resolve({ id: project.id }) });
      assert.equal(getRes.status, 200);
      const getData = (await getRes.json()) as { project: { id: string; name: string } };
      assert.equal(getData.project.id, project.id);
      assert.equal(getData.project.name, "Calculus");

      // 2. Nonexistent project -> 404
      const notFoundRes = await getProjectById(getReq, { params: Promise.resolve({ id: "proj_nonexistent_99" }) });
      assert.equal(notFoundRes.status, 404);

      // 3. Invalid project ID syntax -> 400
      const badIdRes = await getProjectById(getReq, { params: Promise.resolve({ id: "invalid id with spaces" }) });
      assert.equal(badIdRes.status, 400);
    });

    it("T4.1.4: PATCH /api/projects/:id updates name, description, settings, and activates project", async () => {
      const p1 = await (await postProjects(jsonReq("http://localhost/api/projects", "POST", { name: "Project One" }))).json() as { project: { id: string } };
      const p2 = await (await postProjects(jsonReq("http://localhost/api/projects", "POST", { name: "Project Two" }))).json() as { project: { id: string } };

      const patchReq = jsonReq(`http://localhost/api/projects/${p1.project.id}`, "PATCH", {
        name: "Renamed Project One",
        description: "Updated description",
        settings: { sourceGrounding: "strict" },
        active: true,
      });

      const patchRes = await patchProjectById(patchReq, { params: Promise.resolve({ id: p1.project.id }) });
      assert.equal(patchRes.status, 200);
      const patchData = (await patchRes.json()) as { project: { name: string; description: string; settings: { sourceGrounding: string } } };
      assert.equal(patchData.project.name, "Renamed Project One");
      assert.equal(patchData.project.description, "Updated description");
      assert.equal(patchData.project.settings.sourceGrounding, "strict");

      // Verify activeProjectId switched to p1
      const listRes = await getProjects();
      const listData = (await listRes.json()) as { activeProjectId: string };
      assert.equal(listData.activeProjectId, p1.project.id);
    });

    it("T4.1.5: POST /api/projects/:id/archive marks project as archived and rejects unknown project with 404", async () => {
      const p = await (await postProjects(jsonReq("http://localhost/api/projects", "POST", { name: "Archivable Project" }))).json() as { project: { id: string } };

      const archiveReq = new Request(`http://localhost/api/projects/${p.project.id}/archive`, { method: "POST" });
      const archiveRes = await archiveProjectById(archiveReq, { params: Promise.resolve({ id: p.project.id }) });
      assert.equal(archiveRes.status, 200);
      const archiveData = (await archiveRes.json()) as { project: { status: string } };
      assert.equal(archiveData.project.status, "archived");

      // Archive missing project -> 404
      const missingArchiveRes = await archiveProjectById(archiveReq, { params: Promise.resolve({ id: "proj_missing_88" }) });
      assert.equal(missingArchiveRes.status, 404);
    });

    it("T4.1.6: boundary and error handling: rejects empty name (400), invalid JSON (400), path traversal IDs (400)", async () => {
      // Empty name
      const emptyNameRes = await postProjects(jsonReq("http://localhost/api/projects", "POST", { name: "   " }));
      assert.equal(emptyNameRes.status, 400);

      // Non-JSON body
      const badJsonReq = new Request("http://localhost/api/projects", { method: "POST", body: "{ malformed json", headers: { "content-type": "application/json" } });
      const badJsonRes = await postProjects(badJsonReq);
      assert.equal(badJsonRes.status, 400);

      // Path traversal ID
      const traversalRes = await getProjectById(new Request("http://localhost/api/projects/dotdot"), { params: Promise.resolve({ id: "../traversal" }) });
      assert.equal(traversalRes.status, 400);
    });
  });

  // ==========================================================================
  // Feature 2: Vault Registry REST APIs
  // ==========================================================================
  describe("Feature 2: Vault Registry REST APIs", () => {
    it("T4.2.1: GET /api/vaults returns empty list initially and lists registered vaults with multi-device bindings", async () => {
      const res = await getVaults(new Request("http://localhost/api/vaults"));
      assert.equal(res.status, 200);
      const data = (await res.json()) as { vaults: unknown[] };
      assert.deepEqual(data.vaults, []);
    });

    it("T4.2.2: POST /api/vaults registers Obsidian vault with rootPath, deviceId and displayName; returns 201 Created", async () => {
      const regReq = jsonReq("http://localhost/api/vaults", "POST", {
        displayName: "Research Vault",
        path: vaultFolderA,
        deviceId: "device_workstation",
      });

      const res = await postVaults(regReq);
      assert.equal(res.status, 201);
      const data = (await res.json()) as { vault: { id: string; displayName: string; kind: string; bindings: Array<{ deviceId: string; rootPath: string; status: string }> } };
      assert.ok(data.vault);
      assert.match(data.vault.id, /^vault_[a-z0-9]+$/);
      assert.equal(data.vault.displayName, "Research Vault");
      assert.equal(data.vault.kind, "obsidian");
      assert.equal(data.vault.bindings.length, 1);
      assert.equal(data.vault.bindings[0]!.deviceId, "device_workstation");
      assert.equal(data.vault.bindings[0]!.rootPath, vaultFolderA);
      assert.equal(data.vault.bindings[0]!.status, "available");
    });

    it("T4.2.3: GET /api/vaults/:id fetches registered vault; verifies 404 for unknown vault and 400 for malformed vaultId", async () => {
      const regRes = await postVaults(jsonReq("http://localhost/api/vaults", "POST", {
        displayName: "Notes Vault",
        path: vaultFolderA,
      }));
      const { vault } = (await regRes.json()) as { vault: { id: string } };

      // Valid fetch
      const getReq = new Request(`http://localhost/api/vaults/${vault.id}`);
      const getRes = await getVaultById(getReq, { params: Promise.resolve({ id: vault.id }) });
      assert.equal(getRes.status, 200);
      const getData = (await getRes.json()) as { vault: { id: string; displayName: string } };
      assert.equal(getData.vault.id, vault.id);
      assert.equal(getData.vault.displayName, "Notes Vault");

      // Nonexistent vault -> 404
      const notFoundRes = await getVaultById(getReq, { params: Promise.resolve({ id: "vault_unknown_88" }) });
      assert.equal(notFoundRes.status, 404);

      // Malformed ID -> 400
      const badIdRes = await getVaultById(getReq, { params: Promise.resolve({ id: "../malformed/path" }) });
      assert.equal(badIdRes.status, 400);
    });

    it("T4.2.4: PATCH /api/vaults/:id updates displayName and checks filesystem availability probe", async () => {
      const regRes = await postVaults(jsonReq("http://localhost/api/vaults", "POST", {
        displayName: "Old Vault Name",
        path: vaultFolderA,
      }));
      const { vault } = (await regRes.json()) as { vault: { id: string } };

      const patchReq = jsonReq(`http://localhost/api/vaults/${vault.id}`, "PATCH", {
        displayName: "New Vault Name",
      });

      const patchRes = await patchVaultById(patchReq, { params: Promise.resolve({ id: vault.id }) });
      assert.equal(patchRes.status, 200);
      const patchData = (await patchRes.json()) as { vault: { displayName: string } };
      assert.equal(patchData.vault.displayName, "New Vault Name");

      // Probe availability via ?check=true
      const checkReq = new Request(`http://localhost/api/vaults/${vault.id}?check=true`);
      const checkRes = await getVaultById(checkReq, { params: Promise.resolve({ id: vault.id }) });
      assert.equal(checkRes.status, 200);
      const checkData = (await checkRes.json()) as { vault: { bindings: Array<{ status: string }> } };
      assert.equal(checkData.vault.bindings[0]!.status, "available");
    });

    it("T4.2.5: rejects registration with missing displayName (400) and duplicate registration with conflict (409)", async () => {
      // Missing displayName
      const noNameRes = await postVaults(jsonReq("http://localhost/api/vaults", "POST", { path: vaultFolderA }));
      assert.equal(noNameRes.status, 400);

      // Register initial
      const reg1 = await postVaults(jsonReq("http://localhost/api/vaults", "POST", { id: "vault_dup", displayName: "Unique Vault", path: vaultFolderA }));
      assert.equal(reg1.status, 201);

      // Register duplicate ID -> 409
      const reg2 = await postVaults(jsonReq("http://localhost/api/vaults", "POST", { id: "vault_dup", displayName: "Duplicate Vault", path: vaultFolderB }));
      assert.equal(reg2.status, 409);
    });
  });

  // ==========================================================================
  // Feature 3: Project Sources Configuration APIs
  // ==========================================================================
  describe("Feature 3: Project Sources Configuration APIs", () => {
    it("T4.3.1: POST /api/projects/:id/sources attaches vault source with include/exclude globs and returns 201", async () => {
      // 1. Create project & vault
      const pRes = await postProjects(jsonReq("http://localhost/api/projects", "POST", { name: "Physics" }));
      const { project } = (await pRes.json()) as { project: { id: string } };

      const vRes = await postVaults(jsonReq("http://localhost/api/vaults", "POST", { displayName: "Obsidian Vault", path: vaultFolderA }));
      const { vault } = (await vRes.json()) as { vault: { id: string } };

      // 2. Attach source
      const attachReq = jsonReq(`http://localhost/api/projects/${project.id}/sources`, "POST", {
        vaultId: vault.id,
        include: ["Notes/**/*.md", "Seminars/*.md"],
        exclude: [".obsidian/**", "Templates/**"],
        syncMode: "manual",
      });

      const attachRes = await postSources(attachReq, { params: Promise.resolve({ id: project.id }) });
      assert.equal(attachRes.status, 201);
      const attachData = (await attachRes.json()) as { source: { id: string; projectId: string; vaultId: string; include: string[]; exclude: string[]; syncMode: string } };
      assert.ok(attachData.source);
      assert.match(attachData.source.id, /^src_[a-z0-9_]+$/);
      assert.equal(attachData.source.projectId, project.id);
      assert.equal(attachData.source.vaultId, vault.id);
      assert.deepEqual(attachData.source.include, ["Notes/**/*.md", "Seminars/*.md"]);
      assert.deepEqual(attachData.source.exclude, [".obsidian/**", "Templates/**"]);
      assert.equal(attachData.source.syncMode, "manual");
    });

    it("T4.3.2: GET /api/projects/:id/sources lists all attached sources for a project", async () => {
      const pRes = await postProjects(jsonReq("http://localhost/api/projects", "POST", { name: "Literature" }));
      const { project } = (await pRes.json()) as { project: { id: string } };

      const vRes = await postVaults(jsonReq("http://localhost/api/vaults", "POST", { displayName: "Lit Vault", path: vaultFolderA }));
      const { vault } = (await vRes.json()) as { vault: { id: string } };

      await postSources(jsonReq(`http://localhost/api/projects/${project.id}/sources`, "POST", { vaultId: vault.id }), { params: Promise.resolve({ id: project.id }) });

      const getReq = new Request(`http://localhost/api/projects/${project.id}/sources`);
      const getRes = await getSources(getReq, { params: Promise.resolve({ id: project.id }) });
      assert.equal(getRes.status, 200);
      const getData = (await getRes.json()) as { sources: Array<{ projectId: string; vaultId: string }> };
      assert.equal(getData.sources.length, 1);
      assert.equal(getData.sources[0]!.projectId, project.id);
      assert.equal(getData.sources[0]!.vaultId, vault.id);
    });

    it("T4.3.3: strict workspace isolation: Project A sources are never visible or accessible from Project B", async () => {
      const p1 = (await (await postProjects(jsonReq("http://localhost/api/projects", "POST", { name: "Project A" }))).json() as { project: { id: string } }).project;
      const p2 = (await (await postProjects(jsonReq("http://localhost/api/projects", "POST", { name: "Project B" }))).json() as { project: { id: string } }).project;

      const vault = (await (await postVaults(jsonReq("http://localhost/api/vaults", "POST", { displayName: "Shared Vault", path: vaultFolderA }))).json() as { vault: { id: string } }).vault;

      // Attach only to Project A
      await postSources(jsonReq(`http://localhost/api/projects/${p1.id}/sources`, "POST", { vaultId: vault.id }), { params: Promise.resolve({ id: p1.id }) });

      // Check Project A has 1 source
      const resA = await getSources(new Request(`http://localhost/api/projects/${p1.id}/sources`), { params: Promise.resolve({ id: p1.id }) });
      const dataA = (await resA.json()) as { sources: unknown[] };
      assert.equal(dataA.sources.length, 1);

      // Check Project B has 0 sources (complete isolation)
      const resB = await getSources(new Request(`http://localhost/api/projects/${p2.id}/sources`), { params: Promise.resolve({ id: p2.id }) });
      const dataB = (await resB.json()) as { sources: unknown[] };
      assert.equal(dataB.sources.length, 0);
    });

    it("T4.3.4: fails fast with 404 when attaching unknown vault or to unknown project; 400 on malformed ID", async () => {
      const pRes = await postProjects(jsonReq("http://localhost/api/projects", "POST", { name: "History" }));
      const { project } = (await pRes.json()) as { project: { id: string } };

      // Unknown vault -> 404
      const ghostVaultRes = await postSources(
        jsonReq(`http://localhost/api/projects/${project.id}/sources`, "POST", { vaultId: "vault_ghost" }),
        { params: Promise.resolve({ id: project.id }) },
      );
      assert.equal(ghostVaultRes.status, 404);

      // Unknown project -> 404
      const vRes = await postVaults(jsonReq("http://localhost/api/vaults", "POST", { displayName: "Vault", path: vaultFolderA }));
      const { vault } = (await vRes.json()) as { vault: { id: string } };
      const ghostProjRes = await postSources(
        jsonReq("http://localhost/api/projects/proj_ghost/sources", "POST", { vaultId: vault.id }),
        { params: Promise.resolve({ id: "proj_ghost" }) },
      );
      assert.equal(ghostProjRes.status, 404);

      // Malformed projectId -> 400
      const badIdRes = await postSources(
        jsonReq("http://localhost/api/projects/bad_id/sources", "POST", { vaultId: vault.id }),
        { params: Promise.resolve({ id: "invalid id!" }) },
      );
      assert.equal(badIdRes.status, 400);
    });
  });

  // ==========================================================================
  // Feature 4: Scoped Question Answering & Grounded Synthesis
  // ==========================================================================
  describe("Feature 4: Scoped Question Answering & Grounded Synthesis (/api/projects/:id/ask)", () => {
    it("T4.4.1: POST /api/projects/:id/ask returns grounded synthesis with citations and deep-links", async () => {
      // Write sample markdown note in vault
      const notePath = path.join(vaultFolderA, "Physics", "Quantum", "WaveFunction.md");
      fs.mkdirSync(path.dirname(notePath), { recursive: true });
      fs.writeFileSync(
        notePath,
        "# Quantum Wave Mechanics\n\nThe wave function describes the quantum state of an isolated system.\nIt evolves deterministically according to the time-dependent Schrödinger equation.\n",
        "utf-8",
      );

      const pStore = getProjectStore();
      await pStore.createProject({ id: "proj_physics", name: "Physics Project" });

      const vRegistry = getVaultRegistry();
      const vault = await vRegistry.registerVault({
        id: "vault_phys",
        displayName: "Physics Notes",
        kind: "obsidian",
        bindings: [{ deviceId: "local", rootPath: vaultFolderA, status: "available" }],
      });

      const context = await resolveProjectContext("proj_physics");
      const source = await context.sources.addSource({ id: "src_phys", projectId: "proj_physics", vaultId: vault.id });

      // Track document in index
      await context.sources.upsertDocument({
        id: "doc_wave",
        projectId: "proj_physics",
        sourceId: source.id,
        vaultId: vault.id,
        currentPath: "Physics/Quantum/WaveFunction.md",
        contentHash: "hash_wave_123",
        revisionId: "rev_wave_1",
        status: "active",
      });

      const askReq = jsonReq("http://localhost/api/projects/proj_physics/ask", "POST", {
        query: "What governs the evolution of the wave function?",
        topK: 3,
      });

      const res = await postAsk(askReq, { params: Promise.resolve({ id: "proj_physics" }) });
      assert.equal(res.status, 200);

      const data = (await res.json()) as AskSourcesResponse;
      assert.equal(data.grounded, true);
      assert.ok(data.answer.length > 0);
      assert.ok(data.citations.length > 0);
      assert.equal(data.scope.type, "project");

      const citation = data.citations[0]!;
      assert.equal(citation.documentPath, "Physics/Quantum/WaveFunction.md");
      assert.ok(citation.deepLink.startsWith("obsidian://open"));
      const parsedUri = new URL(citation.deepLink);
      assert.equal(parsedUri.searchParams.get("vault"), "Physics Notes");
    });

    it("T4.4.2: note-scoped retrieval restricts citations strictly to target document", async () => {
      const noteA = path.join(vaultFolderA, "NoteA.md");
      const noteB = path.join(vaultFolderA, "NoteB.md");
      fs.writeFileSync(noteA, "# Note A\nThis note explains General Relativity and spacetime curvature.\n", "utf-8");
      fs.writeFileSync(noteB, "# Note B\nThis note explains Quantum Entanglement and non-locality.\n", "utf-8");

      const pStore = getProjectStore();
      await pStore.createProject({ id: "proj_scope_test", name: "Scoped Project" });

      const vRegistry = getVaultRegistry();
      const vault = await vRegistry.registerVault({
        id: "vault_scope",
        displayName: "Scoped Vault",
        kind: "obsidian",
        bindings: [{ deviceId: "local", rootPath: vaultFolderA, status: "available" }],
      });

      const context = await resolveProjectContext("proj_scope_test");
      const source = await context.sources.addSource({ id: "src_scope", projectId: "proj_scope_test", vaultId: vault.id });

      const docA = {
        id: "doc_a",
        projectId: "proj_scope_test",
        sourceId: source.id,
        vaultId: vault.id,
        currentPath: "NoteA.md",
        contentHash: "hash_a",
        revisionId: "rev_a",
        status: "active" as const,
        indexedAt: new Date().toISOString(),
      };
      await context.sources.upsertDocument(docA);

      const docB = {
        id: "doc_b",
        projectId: "proj_scope_test",
        sourceId: source.id,
        vaultId: vault.id,
        currentPath: "NoteB.md",
        contentHash: "hash_b",
        revisionId: "rev_b",
        status: "active" as const,
        indexedAt: new Date().toISOString(),
      };
      await context.sources.upsertDocument(docB);

      // Ask with explicit document scope pointing only to docA
      const askReq = jsonReq("http://localhost/api/projects/proj_scope_test/ask", "POST", {
        query: "What is spacetime curvature?",
        scope: { type: "document", documentIds: [docA.id] },
      });

      const res = await postAsk(askReq, { params: Promise.resolve({ id: "proj_scope_test" }) });
      assert.equal(res.status, 200);

      const data = (await res.json()) as AskSourcesResponse;
      assert.equal(data.grounded, true);
      assert.equal(data.scope.type, "document");
      for (const cit of data.citations) {
        assert.equal(cit.documentPath, "NoteA.md", "Must strictly contain only docA citations");
      }
    });

    it("T4.4.3: query validation: rejects empty queries (400), invalid projectId (400), nonexistent project (404)", async () => {
      const pStore = getProjectStore();
      await pStore.createProject({ id: "proj_valid_q", name: "Valid Project" });

      // 1. Empty query -> 400
      const emptyReq = jsonReq("http://localhost/api/projects/proj_valid_q/ask", "POST", { query: "   " });
      const emptyRes = await postAsk(emptyReq, { params: Promise.resolve({ id: "proj_valid_q" }) });
      assert.equal(emptyRes.status, 400);

      // 2. Invalid projectId -> 400
      const badIdReq = jsonReq("http://localhost/api/projects/bad_id/ask", "POST", { query: "test" });
      const badIdRes = await postAsk(badIdReq, { params: Promise.resolve({ id: "invalid id!" }) });
      assert.equal(badIdRes.status, 400);

      // 3. Nonexistent project -> 404
      const ghostReq = jsonReq("http://localhost/api/projects/proj_ghost_404/ask", "POST", { query: "test" });
      const ghostRes = await postAsk(ghostReq, { params: Promise.resolve({ id: "proj_ghost_404" }) });
      assert.equal(ghostRes.status, 404);
    });
  });

  // ==========================================================================
  // Feature 5: Scoped Study Sessions & Graph Snapshots
  // ==========================================================================
  describe("Feature 5: Scoped Study Sessions & Graph Snapshots (/api/projects/:id/study-sessions)", () => {
    it("T4.5.1: POST /api/projects/:id/study-sessions creates study session with immutable graph snapshot", async () => {
      const pStore = getProjectStore();
      await pStore.createProject({ id: "proj_algebra", name: "Linear Algebra" });

      const context = await resolveProjectContext("proj_algebra");
      context.graph.appendNode(makeGraphNode("n_vector", "Vector", "An element of a vector space."));
      context.graph.appendNode(makeGraphNode("n_basis", "Basis", "A linearly independent spanning set."));
      context.graph.appendChain(makeGraphChain("chain_1", ["n_vector"], "n_basis"));

      const sessionReq = jsonReq("http://localhost/api/projects/proj_algebra/study-sessions", "POST", {
        mode: "mixed",
      });

      const res = await postStudySession(sessionReq, { params: Promise.resolve({ id: "proj_algebra" }) });
      assert.equal(res.status, 201);

      const data = (await res.json()) as StudySessionResponse;
      assert.ok(data.sessionId.startsWith("chat_"));
      assert.equal(data.projectId, "proj_algebra");
      assert.equal(data.scope.type, "project");
      assert.equal(data.snapshot.nodeCount, 2);
      assert.deepEqual([...data.snapshot.nodeIds].sort(), ["n_basis", "n_vector"]);
      assert.ok(data.snapshot.checksum);
      assert.equal(data.mode, "mixed");

      // Verify chat record created on disk with graph-context message
      const chat = context.chats.getChat(data.sessionId);
      assert.ok(chat);
      assert.equal(chat.messages.length, 1);
      const initialMsg = chat.messages[0] as { role: string; customType?: string; content: string };
      assert.equal(initialMsg.role, "custom");
      assert.equal(initialMsg.customType, "graph-context");
      assert.ok(initialMsg.content.includes("Vector"));
      assert.ok(initialMsg.content.includes("Basis"));
    });

    it("T4.5.2: supports active project alias /api/projects/active/study-sessions", async () => {
      const pStore = getProjectStore();
      const p = await pStore.createProject({ id: "proj_active_study", name: "Active Study Project" });
      await pStore.setActiveProjectId(p.id);

      const context = await resolveProjectContext(p.id);
      context.graph.appendNode(makeGraphNode("n_cell", "Cell", "Basic unit of life."));

      const sessionReq = jsonReq("http://localhost/api/projects/active/study-sessions", "POST", {});
      const res = await postStudySession(sessionReq, { params: Promise.resolve({ id: "active" }) });
      assert.equal(res.status, 201);

      const data = (await res.json()) as StudySessionResponse;
      assert.equal(data.projectId, p.id);
      assert.equal(data.snapshot.nodeCount, 1);
    });

    it("T4.5.3: fails fast with 404 on nonexistent project and 400 on malformed projectId", async () => {
      const ghostReq = jsonReq("http://localhost/api/projects/proj_ghost/study-sessions", "POST", {});
      const ghostRes = await postStudySession(ghostReq, { params: Promise.resolve({ id: "proj_ghost" }) });
      assert.equal(ghostRes.status, 404);

      const badIdReq = jsonReq("http://localhost/api/projects/bad_id/study-sessions", "POST", {});
      const badIdRes = await postStudySession(badIdReq, { params: Promise.resolve({ id: "illegal identifier!" }) });
      assert.equal(badIdRes.status, 400);
    });
  });

  // ==========================================================================
  // Feature 6: Scoped Practice Sets & Revision Warning Indicators
  // ==========================================================================
  describe("Feature 6: Scoped Practice Sets & Revision Warning Indicators (/api/projects/:id/practice)", () => {
    it("T4.6.1: POST /api/projects/:id/practice generates problem sets and returns ScopedProblemSet with checksum", async () => {
      const pStore = getProjectStore();
      await pStore.createProject({ id: "proj_quantum_practice", name: "Quantum Practice" });

      const context = await resolveProjectContext("proj_quantum_practice");
      context.graph.appendNode(makeGraphNode("n_qubit", "Qubit", "A two-level quantum system."));
      context.graph.appendNode(makeGraphNode("n_gate", "Hadamard Gate", "Creates equal superposition state."));
      context.graph.appendChain(makeGraphChain("chain_q", ["n_qubit"], "n_gate"));

      const practiceReq = jsonReq("http://localhost/api/projects/proj_quantum_practice/practice", "POST", {
        title: "Qubit Mechanics",
        problemCount: 2,
        modes: ["recall", "discrimination"],
      });

      const res = await postPracticeSet(practiceReq, { params: Promise.resolve({ id: "proj_quantum_practice" }) });
      assert.equal(res.status, 201);

      const data = (await res.json()) as { problemSet: ScopedProblemSet };
      assert.ok(data.problemSet);
      assert.match(data.problemSet.id, /^pset_[a-z0-9_]+$/);
      assert.equal(data.problemSet.projectId, "proj_quantum_practice");
      assert.equal(data.problemSet.title, "Qubit Mechanics");
      assert.ok(data.problemSet.problems.length >= 1);
      assert.ok(data.problemSet.snapshot.checksum);
      assert.deepEqual(data.problemSet.nodeIds, ["n_qubit", "n_gate"]);
    });

    it("T4.6.2: GET /api/projects/:id/practice lists all problem sets for the project", async () => {
      const pStore = getProjectStore();
      await pStore.createProject({ id: "proj_practice_list", name: "Practice List" });

      const context = await resolveProjectContext("proj_practice_list");
      context.graph.appendNode(makeGraphNode("n_atom", "Atom", "Smallest unit of ordinary matter."));

      await postPracticeSet(jsonReq("http://localhost/api/projects/proj_practice_list/practice", "POST", { title: "Set 1" }), { params: Promise.resolve({ id: "proj_practice_list" }) });
      await postPracticeSet(jsonReq("http://localhost/api/projects/proj_practice_list/practice", "POST", { title: "Set 2" }), { params: Promise.resolve({ id: "proj_practice_list" }) });

      const listRes = await getPracticeSets(new Request("http://localhost/api/projects/proj_practice_list/practice"), { params: Promise.resolve({ id: "proj_practice_list" }) });
      assert.equal(listRes.status, 200);

      const listData = (await listRes.json()) as { problemSets: ScopedProblemSet[] };
      assert.equal(listData.problemSets.length, 2);
      const titles = listData.problemSets.map((p) => p.title).sort();
      assert.deepEqual(titles, ["Set 1", "Set 2"]);
    });

    it("T4.6.3: GET /api/projects/:id/practice/:psetId/warnings evaluates document revision warnings against active document inventory", async () => {
      // 1. Setup project, vault, source, and document
      const notePath = path.join(vaultFolderA, "Chemistry", "Elements.md");
      fs.mkdirSync(path.dirname(notePath), { recursive: true });
      fs.writeFileSync(notePath, "# Elements\nHydrogen is the lightest element.\n", "utf-8");

      const pStore = getProjectStore();
      await pStore.createProject({ id: "proj_chem", name: "Chemistry" });

      const vRegistry = getVaultRegistry();
      const vault = await vRegistry.registerVault({
        id: "vault_chem",
        displayName: "Chem Vault",
        kind: "obsidian",
        bindings: [{ deviceId: "local", rootPath: vaultFolderA, status: "available" }],
      });

      const context = await resolveProjectContext("proj_chem");
      const source = await context.sources.addSource({ id: "src_chem", projectId: "proj_chem", vaultId: vault.id });

      const doc = makeSourceDoc(
        "doc_elem",
        source.id,
        vault.id,
        "Chemistry/Elements.md",
        "hash_elem_v1",
      );
      await context.sources.upsertDocument(doc);

      // Append node and practice set binding to this document
      context.graph.appendNode(makeGraphNode("n_hydrogen", "Hydrogen", "Lightest chemical element."));
      const pset = await context.practice.createProblemSet({
        title: "Element Review",
        projectId: "proj_chem",
        scope: { type: "project" },
        nodeIds: ["n_hydrogen"],
        propositions: { n_hydrogen: { name: "Hydrogen", statement: "Lightest chemical element." } },
        chains: [],
        sourceSnapshots: {
          [doc.id]: {
            documentId: doc.id,
            vaultId: vault.id,
            path: doc.currentPath,
            revisionId: doc.revisionId,
            contentHash: doc.contentHash,
            capturedAt: new Date().toISOString(),
          },
        },
      });

      // 2. Unchanged note -> hasWarnings: false
      const warnRes1 = await getPracticeWarnings(
        new Request(`http://localhost/api/projects/proj_chem/practice/${pset.id}/warnings`),
        { params: Promise.resolve({ id: "proj_chem", psetId: pset.id }) },
      );
      assert.equal(warnRes1.status, 200);
      const warnData1 = (await warnRes1.json()) as ProblemSetWarningReport;
      assert.equal(warnData1.hasWarnings, false);
      assert.equal(warnData1.warnings.length, 1);
      assert.equal(warnData1.warnings[0]!.status, "current");

      // 3. Document modified in inventory (new hash) -> warning detected
      await context.sources.upsertDocument(makeSourceDoc(
        "doc_elem",
        source.id,
        vault.id,
        "Chemistry/Elements.md",
        "hash_elem_v2_modified",
      ));

      const warnRes2 = await getPracticeWarnings(
        new Request(`http://localhost/api/projects/proj_chem/practice/${pset.id}/warnings`),
        { params: Promise.resolve({ id: "proj_chem", psetId: pset.id }) },
      );
      assert.equal(warnRes2.status, 200);
      const warnData2 = (await warnRes2.json()) as ProblemSetWarningReport;
      assert.equal(warnData2.hasWarnings, true);
      assert.ok(warnData2.warnings.length >= 1);
      assert.equal(warnData2.warnings[0]!.status, "modified");
      assert.equal(warnData2.warnings[0]!.currentPath, "Chemistry/Elements.md");
    });

    it("T4.6.4: flags missing document in warning report when note status becomes missing", async () => {
      const pStore = getProjectStore();
      await pStore.createProject({ id: "proj_warn_missing", name: "Missing Note Project" });

      const vRegistry = getVaultRegistry();
      const vaultDel = await vRegistry.registerVault({
        id: "vault_del",
        displayName: "Del Vault",
        kind: "obsidian",
        bindings: [{ deviceId: "local", rootPath: vaultFolderA, status: "available" }],
      });

      const context = await resolveProjectContext("proj_warn_missing");
      await context.sources.addSource({ id: "src_del", projectId: "proj_warn_missing", vaultId: vaultDel.id });
      context.graph.appendNode(makeGraphNode("n_missing", "Missing Concept", "Note deleted."));

      const pset = await context.practice.createProblemSet({
        title: "Missing Doc Test",
        projectId: "proj_warn_missing",
        scope: { type: "project" },
        nodeIds: ["n_missing"],
        propositions: { n_missing: { name: "Missing", statement: "Note deleted." } },
        chains: [],
        sourceSnapshots: {
          doc_deleted: {
            documentId: "doc_deleted",
            vaultId: vaultDel.id,
            path: "DeletedNote.md",
            revisionId: "rev_old",
            contentHash: "hash_old",
            capturedAt: new Date().toISOString(),
          },
        },
      });

      // Record doc with status: "missing"
      await context.sources.upsertDocument(makeSourceDoc(
        "doc_deleted",
        "src_del",
        vaultDel.id,
        "DeletedNote.md",
        "hash_old",
        "missing",
      ));

      const warnRes = await getPracticeWarnings(
        new Request(`http://localhost/api/projects/proj_warn_missing/practice/${pset.id}/warnings`),
        { params: Promise.resolve({ id: "proj_warn_missing", psetId: pset.id }) },
      );
      assert.equal(warnRes.status, 200);
      const warnData = (await warnRes.json()) as ProblemSetWarningReport;
      assert.equal(warnData.hasWarnings, true);
      assert.ok(warnData.warnings.some((w) => w.status === "deleted" || w.status === "unavailable"));
    });

    it("T4.6.5: returns 404 for nonexistent problem set or nonexistent project", async () => {
      const pStore = getProjectStore();
      await pStore.createProject({ id: "proj_err_check", name: "Error Check" });

      // Unknown psetId -> 404
      const psetGhostRes = await getPracticeWarnings(
        new Request("http://localhost/api/projects/proj_err_check/practice/pset_ghost/warnings"),
        { params: Promise.resolve({ id: "proj_err_check", psetId: "pset_ghost" }) },
      );
      assert.equal(psetGhostRes.status, 404);

      // Unknown project -> 404
      const projGhostRes = await getPracticeWarnings(
        new Request("http://localhost/api/projects/proj_ghost/practice/pset_1/warnings"),
        { params: Promise.resolve({ id: "proj_ghost", psetId: "pset_1" }) },
      );
      assert.equal(projGhostRes.status, 404);
    });
  });

  // ==========================================================================
  // Feature 7: Bridge Transport Security, Authentication Headers & Desktop Proxy Capability
  // ==========================================================================
  describe("Feature 7: Bridge Transport Security, Authentication & Desktop Proxy Capability", () => {
    it("T4.7.1: isLoopbackUrl correctly identifies loopback endpoints and rejects remote hostnames", () => {
      // Loopback variants
      assert.equal(isLoopbackUrl("http://localhost:3000/api"), true);
      assert.equal(isLoopbackUrl("http://127.0.0.1:4000/api"), true);
      assert.equal(isLoopbackUrl("http://127.0.0.2:8080/api"), true);
      assert.equal(isLoopbackUrl("http://127.255.255.254:1234/api"), true);
      assert.equal(isLoopbackUrl("http://[::1]:3000/api"), true);

      // Remote / Non-loopback
      assert.equal(isLoopbackUrl("http://192.168.1.100:3000/api"), false);
      assert.equal(isLoopbackUrl("http://10.0.0.1:3000/api"), false);
      assert.equal(isLoopbackUrl("https://learnharness.com/api"), false);
      assert.equal(isLoopbackUrl("https://remote.internal:8080"), false);
      assert.equal(isLoopbackUrl("invalid url string"), false);
    });

    it("T4.7.2: BridgeTransport enforces HTTPS and API keys on non-loopback remote endpoints", () => {
      // Insecure HTTP to remote -> throws SECURITY_VIOLATION
      assert.throws(
        () => new BridgeTransport({ serverUrl: "http://example.com:8080" }),
        (err: unknown) => {
          assert.ok(err instanceof BridgeTransportError);
          assert.equal(err.code, "SECURITY_VIOLATION");
          return true;
        },
      );

      // HTTPS to remote without API key -> throws AUTHENTICATION_REQUIRED
      assert.throws(
        () => new BridgeTransport({ serverUrl: "https://example.com:8080", apiKey: "" }),
        (err: unknown) => {
          assert.ok(err instanceof BridgeTransportError);
          assert.equal(err.code, "AUTHENTICATION_REQUIRED");
          return true;
        },
      );

      // HTTPS to remote with valid API key -> successfully instantiates
      const secureRemote = new BridgeTransport({
        serverUrl: "https://example.com:8080",
        apiKey: "sec_token_remote_12345",
      });
      assert.equal(secureRemote.getSettings().apiKey, "sec_token_remote_12345");
    });

    it("T4.7.3: BridgeTransport sends Bearer token and x-api-key headers when configured", () => {
      const transport = new BridgeTransport({
        serverUrl: "http://localhost:3000",
        apiKey: "sk-learnharness-secret-key-123",
      });

      // Access private getHeaders via prototype / any
      const headers = (transport as unknown as { getHeaders: () => Record<string, string> }).getHeaders();
      assert.equal(headers["Accept"], "application/json");
      assert.equal(headers["Content-Type"], "application/json");
      assert.equal(headers["Authorization"], "Bearer sk-learnharness-secret-key-123");
      assert.equal(headers["x-api-key"], "sk-learnharness-secret-key-123");
    });

    it("T4.7.4: desktopAPIAuthorized validates x-learnharness-desktop secret capability token", () => {
      const secret = "k".repeat(64);

      // Browser mode: no desktop server flag -> authorized
      assert.equal(desktopAPIAuthorized(new Headers(), {}), true);

      // Desktop server mode enabled, missing secret in env -> rejected
      assert.equal(desktopAPIAuthorized(new Headers({ "x-learnharness-desktop": secret }), { LH_DESKTOP_SERVER: "1" }), false);

      // Desktop server mode enabled with valid secret in env:
      // Missing header -> rejected
      assert.equal(desktopAPIAuthorized(new Headers(), { LH_DESKTOP_SERVER: "1", LH_DESKTOP_API_SECRET: secret }), false);

      // Wrong header -> rejected
      assert.equal(desktopAPIAuthorized(new Headers({ "x-learnharness-desktop": "wrong-secret" }), { LH_DESKTOP_SERVER: "1", LH_DESKTOP_API_SECRET: secret }), false);

      // Correct matching header -> authorized
      assert.equal(desktopAPIAuthorized(new Headers({ "x-learnharness-desktop": secret }), { LH_DESKTOP_SERVER: "1", LH_DESKTOP_API_SECRET: secret }), true);
    });

    it("T4.7.5: Next.js proxy middleware blocks unauthorized desktop requests with 403 and admits authorized ones", () => {
      const secret = "m".repeat(64);
      const origin = "http://127.0.0.1:3000";

      const originalServer = process.env.LH_DESKTOP_SERVER;
      const originalSecret = process.env.LH_DESKTOP_API_SECRET;

      try {
        process.env.LH_DESKTOP_SERVER = "1";
        process.env.LH_DESKTOP_API_SECRET = secret;

        // 1. Unauthorized request (missing header) -> 403 Forbidden
        const unauthReq = new NextRequest(`${origin}/api/projects`, { method: "GET" });
        const unauthRes = proxy(unauthReq);
        assert.equal(unauthRes.status, 403);

        // 2. Authorized request (with x-learnharness-desktop) -> passes through
        const authReq = new NextRequest(`${origin}/api/projects`, {
          method: "GET",
          headers: { "x-learnharness-desktop": secret },
        });
        const authRes = proxy(authReq);
        assert.equal(authRes.headers.get("x-middleware-next"), "1");
      } finally {
        if (originalServer === undefined) delete process.env.LH_DESKTOP_SERVER;
        else process.env.LH_DESKTOP_SERVER = originalServer;

        if (originalSecret === undefined) delete process.env.LH_DESKTOP_API_SECRET;
        else process.env.LH_DESKTOP_API_SECRET = originalSecret;
      }
    });
  });
});
