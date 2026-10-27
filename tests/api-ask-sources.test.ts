/**
 * Comprehensive Integration & Route Tests for Milestone D Slice 3 (Ask Sources API & Engine).
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
	askProjectSources,
	askSources,
	buildGroundedSynthesisPrompt,
	generatePureSynthesisFallback,
} from "../src/server/index.ts";
import { POST as postAsk } from "../app/api/projects/[id]/ask/route.ts";
import type { AskSourcesResponse, RetrievedSection, SourceCitation } from "../src/core/index.ts";
import type { PiEngine } from "../src/agent/models.ts";

const FIXTURES_VAULT_PATH = path.resolve("tests/fixtures/obsidian-vault");

describe("Milestone D Slice 3: Ask Sources API & Grounded Synthesis", () => {
	let tmpDir: string;
	let vaultFolderA: string;
	let vaultFolderB: string;

	beforeEach(async () => {
		clearProjectContextCache();
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-api-ask-test-"));
		vaultFolderA = path.join(tmpDir, "vault_a");
		vaultFolderB = path.join(tmpDir, "vault_b");
		fs.mkdirSync(vaultFolderA, { recursive: true });
		fs.mkdirSync(vaultFolderB, { recursive: true });

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
			if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup error
		}
	});

	it("POST /api/projects/:id/ask returns grounded answer and citations for valid query", async () => {
		const pStore = createProjectStore(tmpDir);
		await pStore.createProject({ id: "proj_quantum", name: "Quantum Physics" });

		const vRegistry = createVaultRegistry(tmpDir);
		const vault = await vRegistry.registerVault({
			id: "vault_physics",
			displayName: "Physics Research",
			kind: "obsidian",
			bindings: [{ deviceId: "local", rootPath: FIXTURES_VAULT_PATH, status: "available" }],
		});

		const context = await resolveProjectContext("proj_quantum");
		const source = await context.sources.addSource({
			id: "src_physics",
			projectId: "proj_quantum",
			vaultId: vault.id,
		});

		await context.sources.upsertDocument({
			id: "doc_schrodinger",
			projectId: "proj_quantum",
			sourceId: source.id,
			vaultId: vault.id,
			currentPath: "Physics/Quantum/Schrodinger.md",
			contentHash: "hash_123",
			revisionId: "rev_1",
			status: "active",
		});

		const req = new Request("http://localhost/api/projects/proj_quantum/ask", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				query: "Schrödinger wave equation",
				topK: 3,
			}),
		});

		const res = await postAsk(req, { params: Promise.resolve({ id: "proj_quantum" }) });
		assert.equal(res.status, 200);

		const data = (await res.json()) as AskSourcesResponse;
		assert.equal(data.grounded, true);
		assert.ok(data.answer.length > 0);
		assert.ok(data.citations.length > 0);
		assert.equal(data.scope.type, "project");

		const primaryCitation = data.citations[0];
		assert.ok(primaryCitation);
		assert.equal(primaryCitation.documentPath, "Physics/Quantum/Schrodinger.md");
		assert.ok(primaryCitation.lineRange.start >= 1);
		assert.ok(primaryCitation.lineRange.end >= primaryCitation.lineRange.start);

		// Deep-link URI verification
		assert.ok(primaryCitation.deepLink.startsWith("obsidian://open"));
		const parsedUrl = new URL(primaryCitation.deepLink);
		assert.equal(parsedUrl.protocol, "obsidian:");
		assert.equal(parsedUrl.hostname, "open");
		assert.equal(parsedUrl.searchParams.get("vault"), "Physics Research");
		assert.equal(parsedUrl.searchParams.get("file"), "Physics/Quantum/Schrodinger");
	});

	it("returns ungrounded response when query has no matching source sections", async () => {
		const pStore = createProjectStore(tmpDir);
		await pStore.createProject({ id: "proj_empty", name: "Empty Project" });

		const req = new Request("http://localhost/api/projects/proj_empty/ask", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				query: "xyzNonExistentQueryTerm123456",
			}),
		});

		const res = await postAsk(req, { params: Promise.resolve({ id: "proj_empty" }) });
		assert.equal(res.status, 200);

		const data = (await res.json()) as AskSourcesResponse;
		assert.equal(data.grounded, false);
		assert.equal(data.citations.length, 0);
		assert.match(data.answer, /could not find any relevant information/i);
	});

	it("fails fast with 400 on empty or whitespace-only query", async () => {
		const pStore = createProjectStore(tmpDir);
		await pStore.createProject({ id: "proj_1", name: "P1" });

		const reqEmpty = new Request("http://localhost/api/projects/proj_1/ask", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ query: "" }),
		});
		const resEmpty = await postAsk(reqEmpty, { params: Promise.resolve({ id: "proj_1" }) });
		assert.equal(resEmpty.status, 400);

		const reqWhitespace = new Request("http://localhost/api/projects/proj_1/ask", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ query: "   \n\t  " }),
		});
		const resWhitespace = await postAsk(reqWhitespace, { params: Promise.resolve({ id: "proj_1" }) });
		assert.equal(resWhitespace.status, 400);
	});

	it("fails fast with 400 on malformed JSON body or invalid projectId", async () => {
		const pStore = createProjectStore(tmpDir);
		await pStore.createProject({ id: "proj_1", name: "P1" });

		const reqInvalidJson = new Request("http://localhost/api/projects/proj_1/ask", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "invalid json string",
		});
		const resJson = await postAsk(reqInvalidJson, { params: Promise.resolve({ id: "proj_1" }) });
		assert.equal(resJson.status, 400);

		const reqBadId = new Request("http://localhost/api/projects/invalid%20id!/ask", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ query: "valid query" }),
		});
		const resBadId = await postAsk(reqBadId, { params: Promise.resolve({ id: "invalid id!" }) });
		assert.equal(resBadId.status, 400);
	});

	it("fails fast with 404 on unknown project", async () => {
		const req = new Request("http://localhost/api/projects/proj_nonexistent_99/ask", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ query: "test query" }),
		});
		const res = await postAsk(req, { params: Promise.resolve({ id: "proj_nonexistent_99" }) });
		assert.equal(res.status, 404);
	});

	it("fails fast with 404 when scope references foreign or non-existent sourceId", async () => {
		const pStore = createProjectStore(tmpDir);
		await pStore.createProject({ id: "proj_scope_err", name: "Scope Err" });

		const req = new Request("http://localhost/api/projects/proj_scope_err/ask", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				query: "quantum",
				scope: {
					type: "source",
					projectId: "proj_scope_err",
					sourceIds: ["src_does_not_exist"],
				},
			}),
		});

		const res = await postAsk(req, { params: Promise.resolve({ id: "proj_scope_err" }) });
		assert.equal(res.status, 404);
		const data = (await res.json()) as { error: string };
		assert.match(data.error, /src_does_not_exist/);
	});

	it("fails fast with 404 when scope references foreign or non-existent documentId", async () => {
		const pStore = createProjectStore(tmpDir);
		await pStore.createProject({ id: "proj_scope_doc_err", name: "Doc Err" });

		const req = new Request("http://localhost/api/projects/proj_scope_doc_err/ask", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				query: "quantum",
				scope: {
					type: "document",
					projectId: "proj_scope_doc_err",
					documentIds: ["doc_does_not_exist"],
				},
			}),
		});

		const res = await postAsk(req, { params: Promise.resolve({ id: "proj_scope_doc_err" }) });
		assert.equal(res.status, 404);
	});

	it("fails fast with 400 on cross-project scope violation", async () => {
		const pStore = createProjectStore(tmpDir);
		await pStore.createProject({ id: "proj_alpha", name: "Alpha" });
		await pStore.createProject({ id: "proj_beta", name: "Beta" });

		const req = new Request("http://localhost/api/projects/proj_alpha/ask", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				query: "test",
				scope: {
					type: "project",
					projectId: "proj_beta", // Mismatched project
				},
			}),
		});

		const res = await postAsk(req, { params: Promise.resolve({ id: "proj_alpha" }) });
		assert.equal(res.status, 400);
	});

	it("strictly enforces multi-project isolation between two separate projects", async () => {
		const pStore = createProjectStore(tmpDir);
		await pStore.createProject({ id: "proj_p1", name: "Project 1" });
		await pStore.createProject({ id: "proj_p2", name: "Project 2" });

		// Vault 1 contains Physics note
		fs.writeFileSync(
			path.join(vaultFolderA, "PhysicsSecret.md"),
			"# Physics Secret\n\nExclusive secret formulation of dark matter.\n",
			"utf-8",
		);

		// Vault 2 contains History note
		fs.writeFileSync(
			path.join(vaultFolderB, "HistorySecret.md"),
			"# History Secret\n\nExclusive secret manuscript of ancient Rome.\n",
			"utf-8",
		);

		const vRegistry = createVaultRegistry(tmpDir);
		const vaultA = await vRegistry.registerVault({
			id: "vault_a",
			displayName: "Vault A",
			kind: "obsidian",
			bindings: [{ deviceId: "local", rootPath: vaultFolderA, status: "available" }],
		});
		const vaultB = await vRegistry.registerVault({
			id: "vault_b",
			displayName: "Vault B",
			kind: "obsidian",
			bindings: [{ deviceId: "local", rootPath: vaultFolderB, status: "available" }],
		});

		const ctx1 = await resolveProjectContext("proj_p1");
		const s1 = await ctx1.sources.addSource({ id: "src_1", projectId: "proj_p1", vaultId: vaultA.id });
		await ctx1.sources.upsertDocument({
			id: "doc_1",
			projectId: "proj_p1",
			sourceId: s1.id,
			vaultId: vaultA.id,
			currentPath: "PhysicsSecret.md",
			contentHash: "h1",
			revisionId: "r1",
			status: "active",
		});

		const ctx2 = await resolveProjectContext("proj_p2");
		const s2 = await ctx2.sources.addSource({ id: "src_2", projectId: "proj_p2", vaultId: vaultB.id });
		await ctx2.sources.upsertDocument({
			id: "doc_2",
			projectId: "proj_p2",
			sourceId: s2.id,
			vaultId: vaultB.id,
			currentPath: "HistorySecret.md",
			contentHash: "h2",
			revisionId: "r2",
			status: "active",
		});

		// Querying proj_p1 for history secret should not find Vault B's content
		const res1 = await postAsk(
			new Request("http://localhost/api/projects/proj_p1/ask", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ query: "ancient Rome" }),
			}),
			{ params: Promise.resolve({ id: "proj_p1" }) },
		);
		const data1 = (await res1.json()) as AskSourcesResponse;
		assert.equal(data1.grounded, false);
		assert.equal(data1.citations.length, 0);

		// Querying proj_p2 for history secret should find Vault B's content
		const res2 = await postAsk(
			new Request("http://localhost/api/projects/proj_p2/ask", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ query: "ancient Rome" }),
			}),
			{ params: Promise.resolve({ id: "proj_p2" }) },
		);
		const data2 = (await res2.json()) as AskSourcesResponse;
		assert.equal(data2.grounded, true);
		assert.equal(data2.citations.length, 1);
		assert.equal(data2.citations[0]?.documentPath, "HistorySecret.md");
	});

	it("supports Obsidian Bridge request compatibility with question alias and context.filePath", async () => {
		const pStore = createProjectStore(tmpDir);
		await pStore.createProject({ id: "proj_bridge", name: "Bridge Project" });

		fs.writeFileSync(
			path.join(vaultFolderA, "TargetNote.md"),
			"# Target Heading\n\nExact bridge context test content here.\n",
			"utf-8",
		);

		const vRegistry = createVaultRegistry(tmpDir);
		const vault = await vRegistry.registerVault({
			id: "vault_bridge",
			displayName: "Bridge Vault",
			kind: "obsidian",
			bindings: [{ deviceId: "local", rootPath: vaultFolderA, status: "available" }],
		});

		const ctx = await resolveProjectContext("proj_bridge");
		const src = await ctx.sources.addSource({
			id: "src_bridge",
			projectId: "proj_bridge",
			vaultId: vault.id,
		});

		await ctx.sources.upsertDocument({
			id: "doc_bridge",
			projectId: "proj_bridge",
			sourceId: src.id,
			vaultId: vault.id,
			currentPath: "TargetNote.md",
			contentHash: "hb",
			revisionId: "rb",
			status: "active",
		});

		const req = new Request("http://localhost/api/projects/proj_bridge/ask", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				question: "bridge context test",
				context: {
					filePath: "TargetNote.md",
				},
				vaultId: vault.id,
			}),
		});

		const res = await postAsk(req, { params: Promise.resolve({ id: "proj_bridge" }) });
		assert.equal(res.status, 200);

		const data = (await res.json()) as AskSourcesResponse;
		assert.equal(data.grounded, true);
		assert.ok(data.citations.length > 0);
		assert.equal(data.citations[0]?.documentPath, "TargetNote.md");
	});

	it("returns extractive answer directly when synthesize flag is false", async () => {
		const pStore = createProjectStore(tmpDir);
		await pStore.createProject({ id: "proj_nosynth", name: "No Synth" });

		fs.writeFileSync(
			path.join(vaultFolderA, "Extractive.md"),
			"# Extractive Section\n\nDirect extractive text line.\n",
			"utf-8",
		);

		const vRegistry = createVaultRegistry(tmpDir);
		const vault = await vRegistry.registerVault({
			id: "vault_nosynth",
			displayName: "No Synth Vault",
			kind: "obsidian",
			bindings: [{ deviceId: "local", rootPath: vaultFolderA, status: "available" }],
		});

		const ctx = await resolveProjectContext("proj_nosynth");
		const src = await ctx.sources.addSource({ id: "src_ns", projectId: "proj_nosynth", vaultId: vault.id });
		await ctx.sources.upsertDocument({
			id: "doc_ns",
			projectId: "proj_nosynth",
			sourceId: src.id,
			vaultId: vault.id,
			currentPath: "Extractive.md",
			contentHash: "hns",
			revisionId: "rns",
			status: "active",
		});

		const res = await postAsk(
			new Request("http://localhost/api/projects/proj_nosynth/ask", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					query: "extractive text",
					synthesize: false,
				}),
			}),
			{ params: Promise.resolve({ id: "proj_nosynth" }) },
		);

		assert.equal(res.status, 200);
		const data = (await res.json()) as AskSourcesResponse;
		assert.equal(data.grounded, true);
		assert.ok(data.answer.includes("[1]"));
		assert.ok(data.answer.includes("Extractive Section"));
	});

	it("pure synthesis fallback formats primary and secondary sections with [1] and [2] anchors", () => {
		const mockSections: RetrievedSection[] = [
			{
				sectionId: "s1",
				content: "First note content discussing Hamiltonian.",
				score: 5.0,
				citation: {
					sourceId: "src_1",
					vaultId: "v1",
					vaultName: "Vault",
					documentPath: "Physics/Mechanics.md",
					sectionHeading: "Hamiltonian Mechanics",
					headingHierarchy: ["Classical", "Hamiltonian Mechanics"],
					lineRange: { start: 1, end: 10 },
					characterRange: { startOffset: 0, endOffset: 100 },
					deepLink: "obsidian://open?vault=Vault&file=Physics%2FMechanics.md",
				},
			},
			{
				sectionId: "s2",
				content: "Second note context on Lagrangian.",
				score: 3.5,
				citation: {
					sourceId: "src_1",
					vaultId: "v1",
					vaultName: "Vault",
					documentPath: "Physics/Lagrange.md",
					sectionHeading: "Lagrangian Mechanics",
					headingHierarchy: ["Classical", "Lagrangian Mechanics"],
					lineRange: { start: 5, end: 15 },
					characterRange: { startOffset: 50, endOffset: 150 },
					deepLink: "obsidian://open?vault=Vault&file=Physics%2FLagrange.md",
				},
			},
		];

		const fallback = generatePureSynthesisFallback("Hamiltonian", mockSections);
		assert.ok(fallback.includes("Physics/Mechanics.md"));
		assert.ok(fallback.includes("[1]"));
		assert.ok(fallback.includes("Physics/Lagrange.md"));
		assert.ok(fallback.includes("[2]"));
	});

	it("builds grounded synthesis prompt strictly binding numbered source citations", () => {
		const mockSections: RetrievedSection[] = [
			{
				sectionId: "s1",
				content: "Energy conservation principle.",
				score: 4.2,
				citation: {
					sourceId: "src_1",
					vaultId: "v1",
					vaultName: "Vault",
					documentPath: "Energy.md",
					sectionHeading: "Conservation",
					headingHierarchy: ["Physics", "Conservation"],
					lineRange: { start: 1, end: 5 },
					characterRange: { startOffset: 0, endOffset: 50 },
					deepLink: "obsidian://open?vault=Vault&file=Energy.md",
				},
			},
		];

		const prompt = buildGroundedSynthesisPrompt("What is energy conservation?", mockSections);
		assert.ok(prompt.system.includes("strictly grounded"));
		assert.match(prompt.system, /cite your statements using bracketed numbers/i);
		assert.ok(prompt.user.includes("[Source 1]: Energy.md > Physics > Conservation (lines 1–5)"));
		assert.ok(prompt.user.includes("Energy conservation principle."));
		assert.ok(prompt.user.includes("Question: What is energy conservation?"));
	});

	it("executes custom model engine seam when injected", async () => {
		const pStore = createProjectStore(tmpDir);
		await pStore.createProject({ id: "proj_seam", name: "Seam Project" });

		fs.writeFileSync(
			path.join(vaultFolderA, "SeamNote.md"),
			"# Quantum Seam\n\nExperimental quantum seam data.\n",
			"utf-8",
		);

		const vRegistry = createVaultRegistry(tmpDir);
		const vault = await vRegistry.registerVault({
			id: "vault_seam",
			displayName: "Seam Vault",
			kind: "obsidian",
			bindings: [{ deviceId: "local", rootPath: vaultFolderA, status: "available" }],
		});

		const ctx = await resolveProjectContext("proj_seam");
		const src = await ctx.sources.addSource({ id: "src_s", projectId: "proj_seam", vaultId: vault.id });
		await ctx.sources.upsertDocument({
			id: "doc_s",
			projectId: "proj_seam",
			sourceId: src.id,
			vaultId: vault.id,
			currentPath: "SeamNote.md",
			contentHash: "hs",
			revisionId: "rs",
			status: "active",
		});

		// Mock PiEngine yielding scripted response
		const fauxEngine: PiEngine = {
			model: { id: "faux-model", provider: "openai" } as any,
			level: "off",
			streamFn: () => {
				return (async function* () {
					yield {
						type: "done",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "Synthesized model answer with citation [1]." }],
						},
					};
				})() as any;
			},
		};

		const result = await askProjectSources(
			ctx,
			{ query: "quantum seam" },
			{ engine: fauxEngine },
		);

		assert.equal(result.grounded, true);
		assert.equal(result.answer, "Synthesized model answer with citation [1].");
		assert.equal(result.citations.length, 1);
		assert.equal(result.citations[0]?.documentPath, "SeamNote.md");
	});
});
