/**
 * Comprehensive Integration & Route Tests for Milestone D Slice 4 (Scoped Study Sessions API & UI).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	createVaultRegistry,
	setVaultRegistry,
	createProjectStore,
	setProjectStore,
	resolveProjectContext,
	clearProjectContextCache,
} from "../src/server/index.ts";
import { POST, GET } from "../app/api/projects/[id]/study-sessions/route.ts";
import {
	type StudySessionResponse,
	validateStudySessionResponse,
	type GraphNode,
	type GraphChain,
	type SourceDocument,
	type LhMarkerMessage,
} from "../src/core/index.ts";


function makeNode(id: string, name: string, statement: string): GraphNode {
	return {
		id,
		name,
		statement,
		aliases: [],
		createdAt: new Date().toISOString(),
		provenance: [],
	};
}

function makeChain(id: string, premises: string[], conclusion: string): GraphChain {
	return {
		id,
		premises,
		conclusion,
		provenance: [],
		createdAt: new Date().toISOString(),
	};
}

describe("Milestone D Slice 4: Scoped Study Sessions API & UI", () => {
	let tmpDir: string;

	beforeEach(async () => {
		clearProjectContextCache();
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-study-sessions-test-"));

		const vRegistry = createVaultRegistry(tmpDir);
		setVaultRegistry(vRegistry);

		const pStore = createProjectStore(tmpDir);
		setProjectStore(pStore);
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

	it("1. POST /api/projects/:id/study-sessions creates default project-wide study session with immutable graph snapshot", async () => {
		const pStore = createProjectStore(tmpDir);
		await pStore.createProject({ id: "proj_algebra", name: "Linear Algebra" });

		const context = await resolveProjectContext("proj_algebra");
		// Seed valid propositions in knowledge graph
		context.graph.appendNode(makeNode("n_matrix", "Matrix", "A rectangular array of numbers."));
		context.graph.appendNode(makeNode("n_vector", "Vector", "An element of a vector space."));

		const req = new Request("http://localhost/api/projects/proj_algebra/study-sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});

		const res = await POST(req, { params: Promise.resolve({ id: "proj_algebra" }) });
		assert.equal(res.status, 201);

		const data = (await res.json()) as StudySessionResponse;
		validateStudySessionResponse(data);

		assert.ok(data.sessionId.startsWith("chat_"));
		assert.equal(data.projectId, "proj_algebra");
		assert.equal(data.scope.type, "project");
		assert.equal(data.snapshot.nodeCount, 2);
		assert.deepEqual(data.snapshot.nodeIds, ["n_matrix", "n_vector"]);
		assert.ok(data.snapshot.checksum);
		assert.equal(data.mode, "mixed");

		// Verify chat record on disk
		const chat = context.chats.getChat(data.sessionId);
		assert.ok(chat);
		assert.equal(chat.scope?.type, "project");
		assert.equal(chat.messages.length, 1);
		const msg0 = chat.messages[0] as LhMarkerMessage;
		assert.ok(msg0);
		assert.equal(msg0.role, "custom");
		assert.equal(msg0.customType, "graph-context");
		assert.ok(typeof msg0.content === "string");
		assert.ok(msg0.content.includes("[Session context]"));
		assert.ok(msg0.content.includes("Matrix"));
		assert.ok(msg0.content.includes("Vector"));
	});

	it("2. POST /api/projects/:id/study-sessions isolates source-scoped study session to source evidence", async () => {
		const pStore = createProjectStore(tmpDir);
		await pStore.createProject({ id: "proj_dual", name: "Dual Sources" });

		const vRegistry = createVaultRegistry(tmpDir);
		const vault = await vRegistry.registerVault({
			id: "vault_shared",
			displayName: "Shared Vault",
			kind: "obsidian",
			bindings: [{ deviceId: "local", rootPath: tmpDir, status: "available" }],
		});

		const context = await resolveProjectContext("proj_dual");
		const srcA = await context.sources.addSource({ id: "src_a", projectId: "proj_dual", vaultId: vault.id });
		const srcB = await context.sources.addSource({ id: "src_b", projectId: "proj_dual", vaultId: vault.id });

		// Seed propositions
		context.graph.appendNode(makeNode("n_a", "Concept A", "From source A"));
		context.graph.appendNode(makeNode("n_b", "Concept B", "From source B"));

		// Seed evidence
		if (context.graph.appendEvidence) {
			await context.graph.appendEvidence([
				{
					id: "ev_1",
					projectId: "proj_dual",
					sourceId: srcA.id,
					documentId: "doc_a",
					revisionId: "rev_1",
					propositionId: "n_a",
					provenance: "explicit-source",
					status: "active",
					extractorVersion: "1.0",
					location: {},
				},
				{
					id: "ev_2",
					projectId: "proj_dual",
					sourceId: srcB.id,
					documentId: "doc_b",
					revisionId: "rev_1",
					propositionId: "n_b",
					provenance: "explicit-source",
					status: "active",
					extractorVersion: "1.0",
					location: {},
				},
			]);
		}

		const req = new Request("http://localhost/api/projects/proj_dual/study-sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				scope: {
					type: "source",
					sourceIds: [srcA.id],
				},
			}),
		});

		const res = await POST(req, { params: Promise.resolve({ id: "proj_dual" }) });
		assert.equal(res.status, 201);

		const data = (await res.json()) as StudySessionResponse;
		assert.equal(data.scope.type, "source");
		assert.equal(data.snapshot.nodeCount, 1);
		assert.deepEqual(data.snapshot.nodeIds, ["n_a"]);
	});

	it("3. POST /api/projects/:id/study-sessions isolates document-scoped study session to document evidence", async () => {
		const pStore = createProjectStore(tmpDir);
		await pStore.createProject({ id: "proj_docs", name: "Doc Scoped" });

		const vRegistry = createVaultRegistry(tmpDir);
		const vault = await vRegistry.registerVault({
			id: "vault_doc",
			displayName: "Doc Vault",
			kind: "obsidian",
			bindings: [{ deviceId: "local", rootPath: tmpDir, status: "available" }],
		});

		const context = await resolveProjectContext("proj_docs");
		const source = await context.sources.addSource({ id: "src_main", projectId: "proj_docs", vaultId: vault.id });

		const doc1: SourceDocument = {
			id: "doc_1",
			projectId: "proj_docs",
			sourceId: source.id,
			vaultId: vault.id,
			currentPath: "Notes/Topic1.md",
			contentHash: "h1",
			revisionId: "r1",
			status: "active",
		};
		await context.sources.upsertDocument(doc1);

		const doc2: SourceDocument = {
			id: "doc_2",
			projectId: "proj_docs",
			sourceId: source.id,
			vaultId: vault.id,
			currentPath: "Notes/Topic2.md",
			contentHash: "h2",
			revisionId: "r2",
			status: "active",
		};
		await context.sources.upsertDocument(doc2);

		context.graph.appendNode(makeNode("n_doc1", "Doc1 Concept", "Statement 1"));
		context.graph.appendNode(makeNode("n_doc2", "Doc2 Concept", "Statement 2"));

		if (context.graph.appendEvidence) {
			await context.graph.appendEvidence([
				{
					id: "ev_d1",
					projectId: "proj_docs",
					sourceId: source.id,
					documentId: doc1.id,
					revisionId: "r1",
					propositionId: "n_doc1",
					provenance: "explicit-source",
					status: "active",
					extractorVersion: "1.0",
					location: {},
				},
				{
					id: "ev_d2",
					projectId: "proj_docs",
					sourceId: source.id,
					documentId: doc2.id,
					revisionId: "r2",
					propositionId: "n_doc2",
					provenance: "explicit-source",
					status: "active",
					extractorVersion: "1.0",
					location: {},
				},
			]);
		}

		const req = new Request("http://localhost/api/projects/proj_docs/study-sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				scope: {
					type: "document",
					documentIds: [doc1.id],
				},
			}),
		});

		const res = await POST(req, { params: Promise.resolve({ id: "proj_docs" }) });
		assert.equal(res.status, 201);

		const data = (await res.json()) as StudySessionResponse;
		assert.equal(data.scope.type, "document");
		assert.equal(data.snapshot.nodeCount, 1);
		assert.deepEqual(data.snapshot.nodeIds, ["n_doc1"]);
	});

	it("4. POST /api/projects/:id/study-sessions respects proposition scope without prerequisites", async () => {
		const pStore = createProjectStore(tmpDir);
		await pStore.createProject({ id: "proj_prop_nopre", name: "Props No Pre" });

		const context = await resolveProjectContext("proj_prop_nopre");
		context.graph.appendNode(makeNode("n_premise", "Premise", "Base fact"));
		context.graph.appendNode(makeNode("n_conclusion", "Conclusion", "Derived theorem"));
		context.graph.appendChain(makeChain("arg_1", ["n_premise"], "n_conclusion"));

		const req = new Request("http://localhost/api/projects/proj_prop_nopre/study-sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				scope: {
					type: "proposition",
					propositionIds: ["n_conclusion"],
					includePrerequisites: false,
				},
			}),
		});

		const res = await POST(req, { params: Promise.resolve({ id: "proj_prop_nopre" }) });
		assert.equal(res.status, 201);

		const data = (await res.json()) as StudySessionResponse;
		assert.equal(data.snapshot.nodeCount, 1);
		assert.deepEqual(data.snapshot.nodeIds, ["n_conclusion"]);
	});

	it("5. POST /api/projects/:id/study-sessions expands prerequisite chain DAG when includePrerequisites is true", async () => {
		const pStore = createProjectStore(tmpDir);
		await pStore.createProject({ id: "proj_prop_pre", name: "Props With Pre" });

		const context = await resolveProjectContext("proj_prop_pre");
		context.graph.appendNode(makeNode("n_root", "Axiom", "Root axiom"));
		context.graph.appendNode(makeNode("n_lemma", "Lemma", "Intermediate lemma"));
		context.graph.appendNode(makeNode("n_theorem", "Theorem", "Final theorem"));

		context.graph.appendChain(makeChain("arg_root", ["n_root"], "n_lemma"));
		context.graph.appendChain(makeChain("arg_lemma", ["n_lemma"], "n_theorem"));

		const req = new Request("http://localhost/api/projects/proj_prop_pre/study-sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				scope: {
					type: "proposition",
					propositionIds: ["n_theorem"],
					includePrerequisites: true,
				},
			}),
		});

		const res = await POST(req, { params: Promise.resolve({ id: "proj_prop_pre" }) });
		assert.equal(res.status, 201);

		const data = (await res.json()) as StudySessionResponse;
		assert.equal(data.snapshot.nodeCount, 3);
		assert.deepEqual(data.snapshot.nodeIds, ["n_lemma", "n_root", "n_theorem"]);
		assert.equal(data.snapshot.chainCount, 2);
	});

	it("6. POST /api/projects/:id/study-sessions formats diagnostic probing prompt for mode 'probe'", async () => {
		const pStore = createProjectStore(tmpDir);
		await pStore.createProject({ id: "proj_modes", name: "Modes" });

		const req = new Request("http://localhost/api/projects/proj_modes/study-sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				mode: "probe",
				topic: "Eigenvalues",
			}),
		});

		const res = await POST(req, { params: Promise.resolve({ id: "proj_modes" }) });
		assert.equal(res.status, 201);

		const data = (await res.json()) as StudySessionResponse;
		assert.equal(data.mode, "probe");
		assert.ok(data.initialPrompt.includes("test and probe my understanding"));
		assert.ok(data.initialPrompt.includes("Eigenvalues"));
	});

	it("7. POST /api/projects/:id/study-sessions formats instructional prompt for mode 'teach'", async () => {
		const pStore = createProjectStore(tmpDir);
		await pStore.createProject({ id: "proj_modes", name: "Modes" });

		const req = new Request("http://localhost/api/projects/proj_modes/study-sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				mode: "teach",
				topic: "Eigenvalues",
			}),
		});

		const res = await POST(req, { params: Promise.resolve({ id: "proj_modes" }) });
		assert.equal(res.status, 201);

		const data = (await res.json()) as StudySessionResponse;
		assert.equal(data.mode, "teach");
		assert.ok(data.initialPrompt.includes("teach and explain"));
		assert.ok(data.initialPrompt.includes("Eigenvalues"));
	});

	it("8. POST /api/projects/:id/study-sessions supports custom title and instructions", async () => {
		const pStore = createProjectStore(tmpDir);
		await pStore.createProject({ id: "proj_custom", name: "Custom Project" });

		const req = new Request("http://localhost/api/projects/proj_custom/study-sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				title: "Exam Preparation Session",
				customInstructions: "Focus on boundary cases and proof structure",
			}),
		});

		const res = await POST(req, { params: Promise.resolve({ id: "proj_custom" }) });
		assert.equal(res.status, 201);

		const data = (await res.json()) as StudySessionResponse;
		assert.equal(data.title, "Exam Preparation Session");
		assert.ok(data.initialPrompt.includes("Focus: Focus on boundary cases and proof structure"));
	});

	it("9. Multi-project isolation: Foreign source returns 404 SourceNotFoundError", async () => {
		const pStore = createProjectStore(tmpDir);
		await pStore.createProject({ id: "proj_alpha", name: "Alpha" });
		await pStore.createProject({ id: "proj_beta", name: "Beta" });

		const vRegistry = createVaultRegistry(tmpDir);
		const vault = await vRegistry.registerVault({
			id: "vault_shared",
			displayName: "Shared",
			kind: "obsidian",
			bindings: [{ deviceId: "local", rootPath: tmpDir, status: "available" }],
		});

		const betaCtx = await resolveProjectContext("proj_beta");
		const betaSrc = await betaCtx.sources.addSource({ id: "src_beta_private", projectId: "proj_beta", vaultId: vault.id });

		const req = new Request("http://localhost/api/projects/proj_alpha/study-sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				scope: {
					type: "source",
					sourceIds: [betaSrc.id],
				},
			}),
		});

		const res = await POST(req, { params: Promise.resolve({ id: "proj_alpha" }) });
		assert.equal(res.status, 404);
		const err = await res.json();
		assert.ok(err.error.includes("Source not found"));
	});

	it("10. Multi-project isolation: Foreign document returns 404 DocumentNotFoundError", async () => {
		const pStore = createProjectStore(tmpDir);
		await pStore.createProject({ id: "proj_alpha", name: "Alpha" });
		await pStore.createProject({ id: "proj_beta", name: "Beta" });

		const vRegistry = createVaultRegistry(tmpDir);
		const vault = await vRegistry.registerVault({
			id: "vault_shared",
			displayName: "Shared",
			kind: "obsidian",
			bindings: [{ deviceId: "local", rootPath: tmpDir, status: "available" }],
		});

		const betaCtx = await resolveProjectContext("proj_beta");
		const betaSrc = await betaCtx.sources.addSource({ id: "src_beta_1", projectId: "proj_beta", vaultId: vault.id });
		const betaDoc: SourceDocument = {
			id: "doc_beta_secret",
			projectId: "proj_beta",
			sourceId: betaSrc.id,
			vaultId: vault.id,
			currentPath: "Secret.md",
			contentHash: "hash_s",
			revisionId: "rev_s",
			status: "active",
		};
		await betaCtx.sources.upsertDocument(betaDoc);

		const req = new Request("http://localhost/api/projects/proj_alpha/study-sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				scope: {
					type: "document",
					documentIds: [betaDoc.id],
				},
			}),
		});

		const res = await POST(req, { params: Promise.resolve({ id: "proj_alpha" }) });
		assert.equal(res.status, 404);
		const err = await res.json();
		assert.ok(err.error.includes("Document not found"));
	});

	it("11. Fails with 400 on invalid projectId parameter format", async () => {
		const req = new Request("http://localhost/api/projects/invalid!id@/study-sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});

		const res = await POST(req, { params: Promise.resolve({ id: "invalid!id@" }) });
		assert.equal(res.status, 400);
	});

	it("12. Fails with 404 on non-existent project", async () => {
		const req = new Request("http://localhost/api/projects/proj_ghost_404/study-sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});

		const res = await POST(req, { params: Promise.resolve({ id: "proj_ghost_404" }) });
		assert.equal(res.status, 404);
	});

	it("13. Fails with 400 when scope.projectId does not match URL projectId", async () => {
		const pStore = createProjectStore(tmpDir);
		await pStore.createProject({ id: "proj_one", name: "One" });

		const req = new Request("http://localhost/api/projects/proj_one/study-sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				scope: {
					projectId: "proj_two",
				},
			}),
		});

		const res = await POST(req, { params: Promise.resolve({ id: "proj_one" }) });
		assert.equal(res.status, 400);
		const err = await res.json();
		assert.ok(err.error.includes("does not match"));
	});

	it("14. Fails with 400 on malformed JSON body", async () => {
		const pStore = createProjectStore(tmpDir);
		await pStore.createProject({ id: "proj_json_err", name: "Json Err" });

		const req = new Request("http://localhost/api/projects/proj_json_err/study-sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "not-json-content{",
		});

		const res = await POST(req, { params: Promise.resolve({ id: "proj_json_err" }) });
		assert.equal(res.status, 400);
	});

	it("15. Fails with 400 on invalid non-object body payload", async () => {
		const pStore = createProjectStore(tmpDir);
		await pStore.createProject({ id: "proj_schema_err", name: "Schema Err" });

		const req = new Request("http://localhost/api/projects/proj_schema_err/study-sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify("plain string is invalid body"),
		});

		const res = await POST(req, { params: Promise.resolve({ id: "proj_schema_err" }) });
		assert.equal(res.status, 400);
	});

	it("16. POST /api/projects/active/study-sessions routes to active project when set", async () => {
		const pStore = createProjectStore(tmpDir);
		const proj = await pStore.createProject({ id: "proj_active_target", name: "Active Target" });
		await pStore.setActiveProjectId(proj.id);

		const req = new Request("http://localhost/api/projects/active/study-sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ topic: "Active Topic" }),
		});

		const res = await POST(req, { params: Promise.resolve({ id: "active" }) });
		assert.equal(res.status, 201);

		const data = (await res.json()) as StudySessionResponse;
		assert.equal(data.projectId, "proj_active_target");
		assert.ok(data.title.includes("Active Topic"));
	});

	it("17. POST /api/projects/active/study-sessions fails with 404 when no active project configured", async () => {
		const req = new Request("http://localhost/api/projects/active/study-sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ topic: "No Active" }),
		});

		const res = await POST(req, { params: Promise.resolve({ id: "active" }) });
		assert.equal(res.status, 404);
		const err = await res.json();
		assert.ok(err.error.includes("No active project"));
	});

	it("18. Obsidian bridge filePath resolves document scope automatically", async () => {
		const pStore = createProjectStore(tmpDir);
		await pStore.createProject({ id: "proj_bridge", name: "Bridge Project" });

		const vRegistry = createVaultRegistry(tmpDir);
		const vault = await vRegistry.registerVault({
			id: "vault_br",
			displayName: "Bridge Vault",
			kind: "obsidian",
			bindings: [{ deviceId: "local", rootPath: tmpDir, status: "available" }],
		});

		const context = await resolveProjectContext("proj_bridge");
		const src = await context.sources.addSource({ id: "src_br", projectId: "proj_bridge", vaultId: vault.id });
		const doc: SourceDocument = {
			id: "doc_bridge_note",
			projectId: "proj_bridge",
			sourceId: src.id,
			vaultId: vault.id,
			currentPath: "Notes/Category/DeepNote.md",
			contentHash: "h_note",
			revisionId: "r_note",
			status: "active",
		};
		await context.sources.upsertDocument(doc);

		const req = new Request("http://localhost/api/projects/proj_bridge/study-sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				filePath: "Notes/Category/DeepNote.md",
				vaultName: "Bridge Vault",
			}),
		});

		const res = await POST(req, { params: Promise.resolve({ id: "proj_bridge" }) });
		assert.equal(res.status, 201);

		const data = (await res.json()) as StudySessionResponse;
		assert.equal(data.scope.type, "document");
		assert.deepEqual(data.scope.documentIds, [doc.id]);
	});

	it("19. Obsidian bridge folderPath resolves document scope for folder contents", async () => {
		const pStore = createProjectStore(tmpDir);
		await pStore.createProject({ id: "proj_bridge_folder", name: "Bridge Folder" });

		const vRegistry = createVaultRegistry(tmpDir);
		const vault = await vRegistry.registerVault({
			id: "vault_f",
			displayName: "Folder Vault",
			kind: "obsidian",
			bindings: [{ deviceId: "local", rootPath: tmpDir, status: "available" }],
		});

		const context = await resolveProjectContext("proj_bridge_folder");
		const src = await context.sources.addSource({ id: "src_f", projectId: "proj_bridge_folder", vaultId: vault.id });
		const doc1: SourceDocument = {
			id: "doc_f1",
			projectId: "proj_bridge_folder",
			sourceId: src.id,
			vaultId: vault.id,
			currentPath: "Mathematics/Algebra.md",
			contentHash: "h_f1",
			revisionId: "r_f1",
			status: "active",
		};
		await context.sources.upsertDocument(doc1);

		const doc2: SourceDocument = {
			id: "doc_f2",
			projectId: "proj_bridge_folder",
			sourceId: src.id,
			vaultId: vault.id,
			currentPath: "Mathematics/Topology.md",
			contentHash: "h_f2",
			revisionId: "r_f2",
			status: "active",
		};
		await context.sources.upsertDocument(doc2);

		const req = new Request("http://localhost/api/projects/proj_bridge_folder/study-sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				folderPath: "Mathematics",
			}),
		});

		const res = await POST(req, { params: Promise.resolve({ id: "proj_bridge_folder" }) });
		assert.equal(res.status, 201);

		const data = (await res.json()) as StudySessionResponse;
		assert.equal(data.scope.type, "document");
		assert.equal(data.scope.documentIds?.length, 2);
		assert.ok(data.scope.documentIds?.includes(doc1.id));
		assert.ok(data.scope.documentIds?.includes(doc2.id));
	});

	it("20. Obsidian bridge selection and heading format into initialPrompt", async () => {
		const pStore = createProjectStore(tmpDir);
		await pStore.createProject({ id: "proj_selection", name: "Selection" });

		const req = new Request("http://localhost/api/projects/proj_selection/study-sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				topic: "Calculus",
				selection: "Let f(x) be continuous on [a, b].\nThen f is bounded on [a, b].",
				heading: "Extreme Value Theorem",
			}),
		});

		const res = await POST(req, { params: Promise.resolve({ id: "proj_selection" }) });
		assert.equal(res.status, 201);

		const data = (await res.json()) as StudySessionResponse;
		assert.ok(data.initialPrompt.includes("Selected text:"));
		assert.ok(data.initialPrompt.includes("> Let f(x) be continuous"));
		assert.ok(data.initialPrompt.includes("> Then f is bounded"));
	});

	it("21. Invariant: Knowledge graph mutations after session creation never alter the session snapshot", async () => {
		const pStore = createProjectStore(tmpDir);
		await pStore.createProject({ id: "proj_immutable", name: "Immutable Test" });

		const context = await resolveProjectContext("proj_immutable");
		context.graph.appendNode(makeNode("n_orig1", "Initial Node 1", "Original statement 1"));
		context.graph.appendNode(makeNode("n_orig2", "Initial Node 2", "Original statement 2"));

		const req = new Request("http://localhost/api/projects/proj_immutable/study-sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});

		const res = await POST(req, { params: Promise.resolve({ id: "proj_immutable" }) });
		assert.equal(res.status, 201);

		const data = (await res.json()) as StudySessionResponse;
		const sessionId = data.sessionId;

		// Verify initial session state
		const initialChat = context.chats.getChat(sessionId);
		assert.ok(initialChat);
		const initialMsg0 = initialChat.messages[0] as LhMarkerMessage;
		assert.ok(initialMsg0);
		const initialMessage0 = JSON.stringify(initialMsg0);
		assert.equal((initialMsg0.details as { propositions: unknown[] })?.propositions.length, 2);

		// Now simulate substantial incremental ingestion / graph updates post-session creation
		context.graph.appendNode(makeNode("n_new3", "New Node 3", "Added later"));
		context.graph.appendNode(makeNode("n_new4", "New Node 4", "Added later"));
		context.graph.appendChain(makeChain("arg_new", ["n_orig1", "n_new3"], "n_new4"));

		// Verify that the saved session record on disk is 100% UNCHANGED and byte-identical
		const reloadedChat = context.chats.getChat(sessionId);
		assert.ok(reloadedChat);
		const reloadedMsg0 = reloadedChat.messages[0] as LhMarkerMessage;
		assert.ok(reloadedMsg0);
		const reloadedMessage0 = JSON.stringify(reloadedMsg0);
		assert.equal(reloadedMessage0, initialMessage0);
		assert.equal((reloadedMsg0.details as { propositions: unknown[] })?.propositions.length, 2);
		assert.deepEqual(reloadedChat.scope, initialChat.scope);
	});

	it("22. GET /api/projects/:id/study-sessions lists only chats possessing a study scope", async () => {
		const pStore = createProjectStore(tmpDir);
		await pStore.createProject({ id: "proj_listing", name: "Listing" });

		const context = await resolveProjectContext("proj_listing");
		// Create 1 study session via API
		const req = new Request("http://localhost/api/projects/proj_listing/study-sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title: "Real Study Session" }),
		});
		await POST(req, { params: Promise.resolve({ id: "proj_listing" }) });

		// Create 1 legacy/standard chat without scope directly
		context.chats.createChat("Normal Chat Without Scope");

		const getReq = new Request("http://localhost/api/projects/proj_listing/study-sessions");
		const getRes = await GET(getReq, { params: Promise.resolve({ id: "proj_listing" }) });
		assert.equal(getRes.status, 200);

		const data = (await getRes.json()) as { sessions: Array<{ id: string; title: string; scope?: unknown }> };
		assert.equal(data.sessions.length, 1);
		const s0 = data.sessions[0];
		assert.ok(s0);
		assert.equal(s0.title, "Real Study Session");
		assert.ok(s0.scope);
	});

	it("23. GET /api/projects/active/study-sessions retrieves study sessions for active project", async () => {
		const pStore = createProjectStore(tmpDir);
		const proj = await pStore.createProject({ id: "proj_act_list", name: "Active List" });
		await pStore.setActiveProjectId(proj.id);

		const context = await resolveProjectContext("proj_act_list");
		context.chats.createChat("Active Study", undefined, {
			type: "project",
			projectId: "proj_act_list",
			includePrerequisites: false,
			grounding: "sources-only",
		});

		const getReq = new Request("http://localhost/api/projects/active/study-sessions");
		const getRes = await GET(getReq, { params: Promise.resolve({ id: "active" }) });
		assert.equal(getRes.status, 200);

		const data = (await getRes.json()) as { sessions: Array<{ id: string; title: string }> };
		assert.equal(data.sessions.length, 1);
		const actS0 = data.sessions[0];
		assert.ok(actS0);
		assert.equal(actS0.title, "Active Study");
	});

	it("24. GET /api/projects/active/study-sessions fails with 404 when no active project configured", async () => {
		const getReq = new Request("http://localhost/api/projects/active/study-sessions");
		const getRes = await GET(getReq, { params: Promise.resolve({ id: "active" }) });
		assert.equal(getRes.status, 404);
	});

	it("25. GET /api/projects/:id/study-sessions fails with 404 on non-existent project", async () => {
		const getReq = new Request("http://localhost/api/projects/proj_unknown_888/study-sessions");
		const getRes = await GET(getReq, { params: Promise.resolve({ id: "proj_unknown_888" }) });
		assert.equal(getRes.status, 404);
	});
});
