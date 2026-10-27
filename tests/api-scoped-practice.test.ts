/**
 * Comprehensive Integration & Route Tests for Milestone D Slice 5
 * (Scoped Practice Sets, Document Warning Indicators, and Practice Mode).
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
import { GET as listOrPostPractice, POST as createPractice } from "../app/api/projects/[id]/practice/route.ts";
import {
	GET as getPracticeItem,
	PATCH as patchPracticeItem,
	DELETE as deletePracticeItem,
} from "../app/api/projects/[id]/practice/[psetId]/route.ts";
import { GET as getPracticeWarnings } from "../app/api/projects/[id]/practice/[psetId]/warnings/route.ts";
import {
	type ScopedProblemSet,
	validateScopedProblemSet,
	type GraphNode,
	type GraphChain,
	type SourceDocument,
	type ProjectSource,
	type DocumentRevisionSnapshot,
	type ProblemSetWarningReport,
	validateProblemSetWarningReport,
} from "../src/core/index.ts";
import { evaluateDocumentWarning, generatePracticeProblems } from "../src/server/practice.ts";

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

function makeSource(id: string, projectId: string, vaultId: string): ProjectSource {
	return {
		id,
		projectId,
		vaultId,
		include: ["**/*"],
		exclude: [".obsidian/**", ".trash/**"],
		recursive: true,
		enabled: true,
		syncMode: "manual",
		deletionPolicy: "retain",
		createdAt: new Date().toISOString(),
	};
}

function makeDoc(
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

describe("Milestone D Slice 5: Scoped Practice Sets & Warning Indicators", () => {
	let tmpDir: string;

	beforeEach(async () => {
		clearProjectContextCache();
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-practice-sets-test-"));

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

	it("1. POST /api/projects/:id/practice creates scoped practice set with immutable graph snapshot", async () => {
		const pStore = createProjectStore(tmpDir);
		await pStore.createProject({ id: "proj_quantum", name: "Quantum Computing" });

		const context = await resolveProjectContext("proj_quantum");
		context.graph.appendNode(makeNode("n_qubit", "Qubit", "A two-level quantum system."));
		context.graph.appendNode(makeNode("n_superposition", "Superposition", "Linear combination of quantum states."));
		context.graph.appendChain(makeChain("c1", ["n_qubit"], "n_superposition"));

		const req = new Request("http://localhost/api/projects/proj_quantum/practice", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				title: "Intro to Qubits",
				problemCount: 2,
				modes: ["recall", "discrimination"],
			}),
		});

		const res = await createPractice(req, { params: Promise.resolve({ id: "proj_quantum" }) });
		assert.equal(res.status, 201);

		const data = (await res.json()) as { problemSet: ScopedProblemSet; snapshot: any };
		validateScopedProblemSet(data.problemSet);

		assert.ok(data.problemSet.id.startsWith("pset_"));
		assert.equal(data.problemSet.projectId, "proj_quantum");
		assert.equal(data.problemSet.title, "Intro to Qubits");
		assert.equal(data.problemSet.snapshot.nodeCount, 2);
		assert.deepEqual(data.problemSet.snapshot.nodeIds, ["n_qubit", "n_superposition"]);
		assert.ok(data.problemSet.snapshot.checksum);
		assert.equal(data.problemSet.problems.length, 2);
		assert.equal(data.problemSet.problems[0]!.mode, "recall");
		assert.equal(data.problemSet.problems[1]!.mode, "discrimination");

		// Mutating graph store afterwards must NOT alter the frozen snapshot (Snapshot Immutability)
		context.graph.appendNode(makeNode("n_entanglement", "Entanglement", "Non-local quantum correlation."));
		const freshRead = await context.practice.getProblemSet(data.problemSet.id);
		assert.ok(freshRead?.snapshot);
		assert.equal(freshRead.snapshot.nodeCount, 2);
		assert.deepEqual(freshRead.snapshot.nodeIds, ["n_qubit", "n_superposition"]);
	});

	it("2. Multi-project tenant isolation: Project Beta cannot read, patch, or delete Project Alpha's practice set", async () => {
		const pStore = createProjectStore(tmpDir);
		await pStore.createProject({ id: "proj_alpha", name: "Alpha Project" });
		await pStore.createProject({ id: "proj_beta", name: "Beta Project" });

		const ctxAlpha = await resolveProjectContext("proj_alpha");
		ctxAlpha.graph.appendNode(makeNode("n_alpha", "Concept Alpha", "Alpha definition"));

		const createReq = new Request("http://localhost/api/projects/proj_alpha/practice", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title: "Alpha Set" }),
		});
		const createRes = await createPractice(createReq, { params: Promise.resolve({ id: "proj_alpha" }) });
		assert.equal(createRes.status, 201);
		const { problemSet } = (await createRes.json()) as { problemSet: ScopedProblemSet };

		// 1. GET from Beta -> 404
		const getReq = new Request(`http://localhost/api/projects/proj_beta/practice/${problemSet.id}`);
		const getRes = await getPracticeItem(getReq, {
			params: Promise.resolve({ id: "proj_beta", psetId: problemSet.id }),
		});
		assert.equal(getRes.status, 404);

		// 2. PATCH from Beta -> 404
		const patchReq = new Request(`http://localhost/api/projects/proj_beta/practice/${problemSet.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title: "Hijacked Title" }),
		});
		const patchRes = await patchPracticeItem(patchReq, {
			params: Promise.resolve({ id: "proj_beta", psetId: problemSet.id }),
		});
		assert.equal(patchRes.status, 404);

		// 3. DELETE from Beta -> 404
		const delReq = new Request(`http://localhost/api/projects/proj_beta/practice/${problemSet.id}`, {
			method: "DELETE",
		});
		const delRes = await deletePracticeItem(delReq, {
			params: Promise.resolve({ id: "proj_beta", psetId: problemSet.id }),
		});
		assert.equal(delRes.status, 404);

		// 4. GET warnings from Beta -> 404
		const warnReq = new Request(`http://localhost/api/projects/proj_beta/practice/${problemSet.id}/warnings`);
		const warnRes = await getPracticeWarnings(warnReq, {
			params: Promise.resolve({ id: "proj_beta", psetId: problemSet.id }),
		});
		assert.equal(warnRes.status, 404);

		// 5. LIST from Beta -> does not contain Alpha's set
		const listReq = new Request("http://localhost/api/projects/proj_beta/practice");
		const listRes = await listOrPostPractice(listReq, { params: Promise.resolve({ id: "proj_beta" }) });
		assert.equal(listRes.status, 200);
		const listData = (await listRes.json()) as { problemSets: ScopedProblemSet[] };
		assert.equal(listData.problemSets.length, 0);

		// Verify Alpha set is completely intact
		const alphaGet = await getPracticeItem(getReq, {
			params: Promise.resolve({ id: "proj_alpha", psetId: problemSet.id }),
		});
		assert.equal(alphaGet.status, 200);
	});

	it("3. Fail-fast validation: invalid project IDs and malformed payloads return 400 or 404", async () => {
		// Malformed project ID
		const req1 = new Request("http://localhost/api/projects/!@#$%/practice");
		const res1 = await listOrPostPractice(req1, { params: Promise.resolve({ id: "!@#$%" }) });
		assert.equal(res1.status, 400);

		// Non-existent project ID
		const req2 = new Request("http://localhost/api/projects/proj_missing/practice");
		const res2 = await listOrPostPractice(req2, { params: Promise.resolve({ id: "proj_missing" }) });
		assert.equal(res2.status, 404);

		// Non-existent problem set ID
		const pStore = createProjectStore(tmpDir);
		await pStore.createProject({ id: "proj_valid", name: "Valid" });
		const req3 = new Request("http://localhost/api/projects/proj_valid/practice/pset_unknown");
		const res3 = await getPracticeItem(req3, {
			params: Promise.resolve({ id: "proj_valid", psetId: "pset_unknown" }),
		});
		assert.equal(res3.status, 404);

		// Invalid JSON body on POST
		const req4 = new Request("http://localhost/api/projects/proj_valid/practice", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "invalid-json{",
		});
		const res4 = await createPractice(req4, { params: Promise.resolve({ id: "proj_valid" }) });
		assert.equal(res4.status, 400);
	});

	it("4. Scope boundary validation: targeting non-existent source or document fails with 404", async () => {
		const pStore = createProjectStore(tmpDir);
		await pStore.createProject({ id: "proj_scoped", name: "Scoped Project" });

		// Target non-existent source
		const reqSrc = new Request("http://localhost/api/projects/proj_scoped/practice", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				scope: {
					type: "source",
					projectId: "proj_scoped",
					sourceIds: ["src_ghost"],
					includePrerequisites: false,
					grounding: "sources-only",
				},
			}),
		});
		const resSrc = await createPractice(reqSrc, { params: Promise.resolve({ id: "proj_scoped" }) });
		assert.equal(resSrc.status, 404);

		// Target non-existent document
		const reqDoc = new Request("http://localhost/api/projects/proj_scoped/practice", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				scope: {
					type: "document",
					projectId: "proj_scoped",
					documentIds: ["doc_ghost"],
					includePrerequisites: false,
					grounding: "sources-only",
				},
			}),
		});
		const resDoc = await createPractice(reqDoc, { params: Promise.resolve({ id: "proj_scoped" }) });
		assert.equal(resDoc.status, 404);
	});

	it("5. Document Warning Evaluation Scenario 1 ('current'): intact note with matching hash", async () => {
		const vRegistry = createVaultRegistry(tmpDir);
		await vRegistry.registerVault({
			id: "vault_cs",
			displayName: "Computer Science",
			kind: "obsidian",
			bindings: [{ deviceId: "dev1", rootPath: "/notes/cs", status: "available" }],
		});

		const pStore = createProjectStore(tmpDir);
		await pStore.createProject({ id: "proj_cs", name: "CS" });
		const context = await resolveProjectContext("proj_cs");

		await context.sources.addSource(makeSource("src_cs", "proj_cs", "vault_cs"));
		const doc = makeDoc("doc_algo", "src_cs", "vault_cs", "algorithms/sorting.md", "hash_initial_123");
		await context.sources.upsertDocument(doc);

		const snapshot: DocumentRevisionSnapshot = {
			documentId: "doc_algo",
			vaultId: "vault_cs",
			vaultName: "Computer Science",
			path: "algorithms/sorting.md",
			contentHash: "hash_initial_123",
			capturedAt: new Date().toISOString(),
		};

		const warning = await evaluateDocumentWarning(snapshot, context, vRegistry);
		assert.equal(warning.status, "current");
		assert.equal(warning.message, "Document is current");
		assert.ok(warning.deepLink);
		assert.ok(warning.deepLink.includes("obsidian://open"));
		assert.ok(warning.deepLink.includes("algorithms%2Fsorting"));
	});

	it("6. Document Warning Evaluation Scenario 2 ('modified'): content hash mismatch", async () => {
		const vRegistry = createVaultRegistry(tmpDir);
		await vRegistry.registerVault({
			id: "vault_cs",
			displayName: "Computer Science",
			kind: "obsidian",
			bindings: [{ deviceId: "dev1", rootPath: "/notes/cs", status: "available" }],
		});

		const pStore = createProjectStore(tmpDir);
		await pStore.createProject({ id: "proj_cs", name: "CS" });
		const context = await resolveProjectContext("proj_cs");

		await context.sources.addSource(makeSource("src_cs", "proj_cs", "vault_cs"));
		// Live document has updated hash
		const updatedDoc = makeDoc("doc_algo", "src_cs", "vault_cs", "algorithms/sorting.md", "hash_modified_999");
		await context.sources.upsertDocument(updatedDoc);

		const snapshot: DocumentRevisionSnapshot = {
			documentId: "doc_algo",
			vaultId: "vault_cs",
			vaultName: "Computer Science",
			path: "algorithms/sorting.md",
			contentHash: "hash_initial_123",
			capturedAt: new Date().toISOString(),
		};

		const warning = await evaluateDocumentWarning(snapshot, context, vRegistry);
		assert.equal(warning.status, "modified");
		assert.equal(warning.currentHash, "hash_modified_999");
		assert.ok(warning.message.includes("hash mismatch"));
		assert.ok(warning.deepLink);
	});

	it("7. Document Warning Evaluation Scenario 3 ('moved'): note moved to a new path", async () => {
		const vRegistry = createVaultRegistry(tmpDir);
		await vRegistry.registerVault({
			id: "vault_cs",
			displayName: "Computer Science",
			kind: "obsidian",
			bindings: [{ deviceId: "dev1", rootPath: "/notes/cs", status: "available" }],
		});

		const pStore = createProjectStore(tmpDir);
		await pStore.createProject({ id: "proj_cs", name: "CS" });
		const context = await resolveProjectContext("proj_cs");

		await context.sources.addSource(makeSource("src_cs", "proj_cs", "vault_cs"));
		// Note moved from algorithms/sorting.md to dsa/sorting.md
		const movedDoc = makeDoc("doc_algo", "src_cs", "vault_cs", "dsa/sorting.md", "hash_initial_123");
		await context.sources.upsertDocument(movedDoc);

		const snapshot: DocumentRevisionSnapshot = {
			documentId: "doc_algo",
			vaultId: "vault_cs",
			vaultName: "Computer Science",
			path: "algorithms/sorting.md",
			contentHash: "hash_initial_123",
			capturedAt: new Date().toISOString(),
		};

		const warning = await evaluateDocumentWarning(snapshot, context, vRegistry);
		assert.equal(warning.status, "moved");
		assert.equal(warning.originalPath, "algorithms/sorting.md");
		assert.equal(warning.currentPath, "dsa/sorting.md");
		assert.ok(warning.message.includes("moved"));
		assert.ok(warning.deepLink?.includes("dsa%2Fsorting"));
	});

	it("8. Document Warning Evaluation Scenario 4 ('deleted'): note removed or marked missing", async () => {
		const vRegistry = createVaultRegistry(tmpDir);
		await vRegistry.registerVault({
			id: "vault_cs",
			displayName: "Computer Science",
			kind: "obsidian",
			bindings: [{ deviceId: "dev1", rootPath: "/notes/cs", status: "available" }],
		});

		const pStore = createProjectStore(tmpDir);
		await pStore.createProject({ id: "proj_cs", name: "CS" });
		const context = await resolveProjectContext("proj_cs");

		await context.sources.addSource(makeSource("src_cs", "proj_cs", "vault_cs"));
		// Document marked missing in inventory
		const deletedDoc = makeDoc("doc_algo", "src_cs", "vault_cs", "algorithms/sorting.md", "hash_initial_123", "missing");
		await context.sources.upsertDocument(deletedDoc);

		const snapshot: DocumentRevisionSnapshot = {
			documentId: "doc_algo",
			vaultId: "vault_cs",
			vaultName: "Computer Science",
			path: "algorithms/sorting.md",
			contentHash: "hash_initial_123",
			capturedAt: new Date().toISOString(),
		};

		const warning = await evaluateDocumentWarning(snapshot, context, vRegistry);
		assert.equal(warning.status, "deleted");
		assert.ok(warning.message.includes("deleted or removed"));
	});

	it("9. Document Warning Evaluation Scenario 5 ('unavailable'): vault disconnected", async () => {
		const vRegistry = createVaultRegistry(tmpDir);
		// Vault is unavailable
		await vRegistry.registerVault({
			id: "vault_cs",
			displayName: "Computer Science",
			kind: "obsidian",
			bindings: [{ deviceId: "dev1", rootPath: "/notes/cs", status: "unavailable" }],
		});

		const pStore = createProjectStore(tmpDir);
		await pStore.createProject({ id: "proj_cs", name: "CS" });
		const context = await resolveProjectContext("proj_cs");

		const snapshot: DocumentRevisionSnapshot = {
			documentId: "doc_algo",
			vaultId: "vault_cs",
			vaultName: "Computer Science",
			path: "algorithms/sorting.md",
			contentHash: "hash_initial_123",
			capturedAt: new Date().toISOString(),
		};

		const warning = await evaluateDocumentWarning(snapshot, context, vRegistry);
		assert.equal(warning.status, "unavailable");
		assert.ok(warning.message.includes("disconnected or unavailable"));
	});

	it("10. Warnings endpoint GET /api/projects/:id/practice/:psetId/warnings returns detailed warning report", async () => {
		const vRegistry = createVaultRegistry(tmpDir);
		await vRegistry.registerVault({
			id: "vault_v1",
			displayName: "Vault 1",
			kind: "obsidian",
			bindings: [{ deviceId: "dev1", rootPath: "/notes", status: "available" }],
		});
		setVaultRegistry(vRegistry);

		const pStore = createProjectStore(tmpDir);
		await pStore.createProject({ id: "proj_w", name: "Warning Test" });
		const context = await resolveProjectContext("proj_w");

		await context.sources.addSource(makeSource("src_1", "proj_w", "vault_v1"));
		await context.sources.upsertDocument(makeDoc("doc_1", "src_1", "vault_v1", "note.md", "hash_new_diff"));

		const pset = await context.practice.createProblemSet({
			projectId: "proj_w",
			title: "Warning Set",
			nodeIds: ["n1"],
			propositions: { n1: { name: "N1", statement: "S1" } },
			chains: [],
			sourceSnapshots: {
				doc_1: {
					documentId: "doc_1",
					vaultId: "vault_v1",
					path: "note.md",
					contentHash: "hash_orig_old",
					capturedAt: new Date().toISOString(),
				},
			},
		});

		const req = new Request(`http://localhost/api/projects/proj_w/practice/${pset.id}/warnings`);
		const res = await getPracticeWarnings(req, {
			params: Promise.resolve({ id: "proj_w", psetId: pset.id }),
		});
		assert.equal(res.status, 200);

		const report = (await res.json()) as ProblemSetWarningReport;
		validateProblemSetWarningReport(report);

		assert.equal(report.hasWarnings, true);
		assert.equal(report.warningCount, 1);
		assert.equal(report.warnings.length, 1);
		assert.equal(report.warnings[0]!.status, "modified");
	});

	it("11. GET /api/projects/:id/practice/:psetId?warnings=true includes warningSummary and warnings array", async () => {
		const vRegistry = createVaultRegistry(tmpDir);
		await vRegistry.registerVault({
			id: "vault_v2",
			displayName: "Vault 2",
			kind: "obsidian",
			bindings: [{ deviceId: "dev1", rootPath: "/notes", status: "available" }],
		});
		setVaultRegistry(vRegistry);

		const pStore = createProjectStore(tmpDir);
		await pStore.createProject({ id: "proj_q", name: "Query Warnings" });
		const context = await resolveProjectContext("proj_q");

		await context.sources.addSource(makeSource("src_2", "proj_q", "vault_v2"));
		await context.sources.upsertDocument(makeDoc("doc_2", "src_2", "vault_v2", "note2.md", "hash_match_ok"));

		const pset = await context.practice.createProblemSet({
			projectId: "proj_q",
			title: "Intact Set",
			nodeIds: ["n2"],
			propositions: { n2: { name: "N2", statement: "S2" } },
			chains: [],
			sourceSnapshots: {
				doc_2: {
					documentId: "doc_2",
					vaultId: "vault_v2",
					path: "note2.md",
					contentHash: "hash_match_ok",
					capturedAt: new Date().toISOString(),
				},
			},
		});

		const req = new Request(`http://localhost/api/projects/proj_q/practice/${pset.id}?warnings=true`);
		const res = await getPracticeItem(req, {
			params: Promise.resolve({ id: "proj_q", psetId: pset.id }),
		});
		assert.equal(res.status, 200);

		const data = (await res.json()) as any;
		assert.ok(data.problemSet);
		assert.ok(data.problemSet.warningSummary);
		assert.equal(data.problemSet.warningSummary.hasWarnings, false);
		assert.equal(data.problemSet.warningSummary.warningCount, 0);
		assert.equal(data.warnings.length, 1);
		assert.equal(data.warnings[0].status, "current");
	});

	it("12. PATCH /api/projects/:id/practice/:psetId updates status and metadata", async () => {
		const pStore = createProjectStore(tmpDir);
		await pStore.createProject({ id: "proj_patch", name: "Patch Test" });
		const context = await resolveProjectContext("proj_patch");

		const pset = await context.practice.createProblemSet({
			projectId: "proj_patch",
			title: "Initial Title",
			nodeIds: [],
			propositions: {},
			chains: [],
		});
		assert.equal(pset.status, "active");

		const patchReq = new Request(`http://localhost/api/projects/proj_patch/practice/${pset.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				status: "completed",
				title: "Completed Title",
			}),
		});

		const patchRes = await patchPracticeItem(patchReq, {
			params: Promise.resolve({ id: "proj_patch", psetId: pset.id }),
		});
		assert.equal(patchRes.status, 200);

		const updated = (await patchRes.json()) as { problemSet: ScopedProblemSet };
		assert.equal(updated.problemSet.status, "completed");
		assert.equal(updated.problemSet.title, "Completed Title");
	});

	it("13. DELETE /api/projects/:id/practice/:psetId removes practice set from disk", async () => {
		const pStore = createProjectStore(tmpDir);
		await pStore.createProject({ id: "proj_del", name: "Del Test" });
		const context = await resolveProjectContext("proj_del");

		const pset = await context.practice.createProblemSet({
			projectId: "proj_del",
			title: "Doomed Set",
			nodeIds: [],
			propositions: {},
			chains: [],
		});

		const delReq = new Request(`http://localhost/api/projects/proj_del/practice/${pset.id}`, {
			method: "DELETE",
		});
		const delRes = await deletePracticeItem(delReq, {
			params: Promise.resolve({ id: "proj_del", psetId: pset.id }),
		});
		assert.equal(delRes.status, 200);

		// Subsequent GET returns 404
		const getReq = new Request(`http://localhost/api/projects/proj_del/practice/${pset.id}`);
		const getRes = await getPracticeItem(getReq, {
			params: Promise.resolve({ id: "proj_del", psetId: pset.id }),
		});
		assert.equal(getRes.status, 404);
	});

	it("14. Active project alias: /api/projects/active/practice resolves to active project", async () => {
		const pStore = createProjectStore(tmpDir);
		const p = await pStore.createProject({ id: "proj_active", name: "Active Proj" });
		await pStore.setActiveProjectId(p.id);

		const context = await resolveProjectContext("proj_active");
		context.graph.appendNode(makeNode("n_act", "Active Concept", "Definition of active"));

		const postReq = new Request("http://localhost/api/projects/active/practice", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title: "Active Set" }),
		});
		const postRes = await createPractice(postReq, { params: Promise.resolve({ id: "active" }) });
		assert.equal(postRes.status, 201);

		const data = (await postRes.json()) as { problemSet: ScopedProblemSet };
		assert.equal(data.problemSet.projectId, "proj_active");

		const listReq = new Request("http://localhost/api/projects/active/practice");
		const listRes = await listOrPostPractice(listReq, { params: Promise.resolve({ id: "active" }) });
		assert.equal(listRes.status, 200);
		const listData = (await listRes.json()) as { problemSets: ScopedProblemSet[] };
		assert.equal(listData.problemSets.length, 1);
		assert.equal(listData.problemSets[0]!.id, data.problemSet.id);
	});

	it("15. Offline pure problem generation produces diverse modes and accurate solutions", () => {
		const nodes = [
			makeNode("n1", "Euler Formula", "e^(i*pi) + 1 = 0"),
			makeNode("n2", "Taylor Series", "f(x) = sum f^(n)(a)/n! * (x-a)^n"),
			makeNode("n3", "Fourier Transform", "Integral transform from time to frequency domain"),
		];

		const problems = generatePracticeProblems({
			nodes,
			problemCount: 3,
			modes: ["recall", "discrimination", "composition"],
		});

		assert.equal(problems.length, 3);
		// Recall
		assert.equal(problems[0]!.mode, "recall");
		assert.ok(problems[0]!.statement.includes("Euler Formula"));
		assert.ok(problems[0]!.modelSolution.includes("e^(i*pi) + 1 = 0"));

		// Discrimination
		assert.equal(problems[1]!.mode, "discrimination");
		assert.ok(problems[1]!.statement.includes("Taylor Series"));
		assert.ok(problems[1]!.statement.includes("Fourier Transform"));

		// Composition
		assert.equal(problems[2]!.mode, "composition");
		assert.ok(problems[2]!.statement.includes("Fourier Transform"));
		assert.ok(problems[2]!.modelSolution.includes("Euler Formula"));
	});

	it("16. Scoped proposition subset and prerequisite expansion preserves DAG dependencies", async () => {
		const pStore = createProjectStore(tmpDir);
		await pStore.createProject({ id: "proj_dag", name: "DAG Project" });
		const context = await resolveProjectContext("proj_dag");

		// Linear chain: n_foundations -> n_calculus -> n_physics
		context.graph.appendNode(makeNode("n_foundations", "Foundations", "Arithmetic and algebra"));
		context.graph.appendNode(makeNode("n_calculus", "Calculus", "Derivatives and integrals"));
		context.graph.appendNode(makeNode("n_physics", "Physics", "Mechanics and forces"));
		context.graph.appendChain(makeChain("c1", ["n_foundations"], "n_calculus"));
		context.graph.appendChain(makeChain("c2", ["n_calculus"], "n_physics"));

		// Target only n_physics with includePrerequisites: true
		const req = new Request("http://localhost/api/projects/proj_dag/practice", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				nodeIds: ["n_physics"],
				scope: {
					type: "proposition",
					projectId: "proj_dag",
					propositionIds: ["n_physics"],
					includePrerequisites: true,
					grounding: "sources-only",
				},
			}),
		});

		const res = await createPractice(req, { params: Promise.resolve({ id: "proj_dag" }) });
		assert.equal(res.status, 201);
		const data = (await res.json()) as { problemSet: ScopedProblemSet };

		// Prerequisite expansion must have pulled in n_foundations and n_calculus
		assert.equal(data.problemSet.snapshot.nodeCount, 3);
		assert.deepEqual(data.problemSet.snapshot.nodeIds, ["n_calculus", "n_foundations", "n_physics"]);
		assert.equal(data.problemSet.snapshot.chainCount, 2);
	});
});
