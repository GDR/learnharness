import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
	validateProjectId,
	resolveProjectContext,
	getProjectAuditLock,
	clearProjectContextCache,
	InvalidProjectIdError,
	ProjectNotFoundError,
} from "../src/server/projects.ts";
import { createProjectStore } from "../src/store/projects.ts";
import { createChatStore } from "../src/store/chats.ts";
import { createGraphStore } from "../src/store/graph.ts";
import { createJobStore } from "../src/store/jobs.ts";
import { createPracticeStore } from "../src/store/practice.ts";
import { createSourceStore } from "../src/store/sources.ts";
import type { GraphNode, GraphChain } from "../src/core/contracts.ts";
import type { SourceDocument } from "../src/core/contracts/project.ts";

describe("Milestone A Slice 2: Store Factories, ProjectContext & Project-Keyed Audit Locks", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-m-a-slice2-test-"));
		clearProjectContextCache();
	});

	afterEach(() => {
		clearProjectContextCache();
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup error
		}
	});

	describe("validateProjectId", () => {
		test("accepts valid alphanumeric, hyphenated, and underscored project IDs", () => {
			assert.equal(validateProjectId("proj_default"), "proj_default");
			assert.equal(validateProjectId("project-123"), "project-123");
			assert.equal(validateProjectId("my_workspace_42"), "my_workspace_42");
			assert.equal(validateProjectId("Alpha-Beta_Gamma"), "Alpha-Beta_Gamma");
		});

		test("rejects non-string and empty inputs with status 400", () => {
			assert.throws(
				() => validateProjectId(""),
				(err: unknown) => err instanceof InvalidProjectIdError && err.status === 400,
			);
			assert.throws(
				() => validateProjectId("   "),
				(err: unknown) => err instanceof InvalidProjectIdError && err.status === 400,
			);
			assert.throws(
				() => validateProjectId(null),
				(err: unknown) => err instanceof InvalidProjectIdError && err.status === 400,
			);
			assert.throws(
				() => validateProjectId(undefined),
				(err: unknown) => err instanceof InvalidProjectIdError && err.status === 400,
			);
			assert.throws(
				() => validateProjectId(123),
				(err: unknown) => err instanceof InvalidProjectIdError && err.status === 400,
			);
		});

		test("rejects path traversal attempts and invalid special characters with status 400", () => {
			const invalidIds = [
				"../escape",
				"proj/sub",
				"proj\\sub",
				"proj*name",
				"proj$money",
				"proj@domain",
				"proj;rm",
				"proj:tag",
			];

			for (const id of invalidIds) {
				assert.throws(
					() => validateProjectId(id),
					(err: unknown) => err instanceof InvalidProjectIdError && err.status === 400,
					`Expected validateProjectId("${id}") to throw InvalidProjectIdError with status 400`,
				);
			}
		});
	});

	describe("resolveProjectContext & Project Isolation", () => {
		test("throws 404 ProjectNotFoundError on unknown project ID with no silent fallback", async () => {
			const projectStore = createProjectStore(tempDir);

			await assert.rejects(
				async () => {
					await resolveProjectContext("proj_nonexistent", {
						dataDir: tempDir,
						projectStore,
					});
				},
				(err: unknown) => {
					return err instanceof ProjectNotFoundError && err.status === 404 && err.projectId === "proj_nonexistent";
				},
			);
		});

		test("resolves ProjectContext and caches instance for existing project", async () => {
			const projectStore = createProjectStore(tempDir);
			const project = await projectStore.createProject({
				name: "Physics Study",
				description: "Mechanics and thermodynamics",
			});

			const context1 = await resolveProjectContext(project.id, {
				dataDir: tempDir,
				projectStore,
			});

			assert.equal(context1.projectId, project.id);
			assert.ok(context1.chats);
			assert.ok(context1.graph);
			assert.ok(context1.jobs);
			assert.ok(context1.practice);
			assert.ok(context1.sources);

			// Check that repeated call returns cached context
			const context2 = await resolveProjectContext(project.id, {
				dataDir: tempDir,
				projectStore,
			});
			assert.equal(context1, context2);
		});

		test("two distinct projects have completely isolated storage across all stores", async () => {
			const projectStore = createProjectStore(tempDir);
			const projA = await projectStore.createProject({ id: "proj_alpha", name: "Project Alpha" });
			const projB = await projectStore.createProject({ id: "proj_beta", name: "Project Beta" });

			const ctxA = await resolveProjectContext(projA.id, { dataDir: tempDir, projectStore });
			const ctxB = await resolveProjectContext(projB.id, { dataDir: tempDir, projectStore });

			// ── 1. Chats Isolation ──
			const chatA = ctxA.chats.createChat("Alpha Chat 1");
			ctxA.chats.saveMessages(chatA.id, [
				{ id: "m1", role: "user", content: "Hello Alpha", timestamp: Date.now() },
			]);

			assert.equal(ctxA.chats.listChats().length, 1);
			assert.equal(ctxB.chats.listChats().length, 0);
			assert.equal(ctxB.chats.getChat(chatA.id), null);

			// ── 2. Graph Isolation ──
			const nodeA: GraphNode = {
				id: "node_alpha_1",
				name: "Kinematics",
				statement: "Kinematics describes motion without considering its causes.",
				aliases: ["Kinematics Theory"],
				createdAt: new Date().toISOString(),
				provenance: [{ chatId: chatA.id, messageId: "m1" }],
			};
			ctxA.graph.appendNode(nodeA);

			const chainA: GraphChain = {
				id: "chain_alpha_1",
				premises: [nodeA.id],
				conclusion: "Kinematics equations apply under constant acceleration.",
				provenance: [{ chatId: chatA.id, messageId: "m1" }],
				createdAt: new Date().toISOString(),
			};
			ctxA.graph.appendChain(chainA);

			assert.equal(ctxA.graph.readNodes().length, 1);
			assert.equal(ctxA.graph.readChains().length, 1);
			assert.equal(ctxB.graph.readNodes().length, 0);
			assert.equal(ctxB.graph.readChains().length, 0);

			// Positions isolation
			ctxA.graph.writePositions({ [nodeA.id]: { x: 100, y: 200 } });
			assert.deepEqual(ctxA.graph.readPositions(), { [nodeA.id]: { x: 100, y: 200 } });
			assert.deepEqual(ctxB.graph.readPositions(), {});

			// ── 3. Jobs Isolation ──
			const jobA = ctxA.jobs.createJob({
				chatId: chatA.id,
				kind: "research",
				toolCallId: "call_tc_1",
				activity: "searching",
			});

			assert.equal(ctxA.jobs.listJobs(chatA.id).length, 1);
			assert.equal(ctxB.jobs.listJobs(chatA.id).length, 0);
			assert.equal(ctxB.jobs.findJobByToolCallId(chatA.id, "call_tc_1"), null);

			// ── 4. Practice Isolation ──
			const psetA = await ctxA.practice.createProblemSet({
				projectId: projA.id,
				title: "Kinematics Quiz 1",
				nodeIds: [nodeA.id],
				propositions: { [nodeA.id]: { name: nodeA.name, statement: nodeA.statement } },
				chains: [chainA],
			});

			const psetsA = await ctxA.practice.listProblemSets(projA.id);
			const psetsB = await ctxB.practice.listProblemSets(projB.id);
			assert.equal(psetsA.length, 1);
			assert.equal(psetsB.length, 0);
			assert.equal(await ctxB.practice.getProblemSet(psetA.id), null);

			// ── 5. Sources Isolation ──
			const sourceA = await ctxA.sources.addSource({
				projectId: projA.id,
				vaultId: "vault_main",
				include: ["physics/**/*.md"],
				exclude: [".obsidian/**"],
				recursive: true,
				enabled: true,
				syncMode: "automatic",
				deletionPolicy: "retain",
			});

			const docA: SourceDocument = {
				id: "doc_1",
				vaultId: "vault_main",
				currentPath: "physics/motion.md",
				contentHash: "hash123abc",
				revisionId: "rev1",
				status: "active",
			};
			await ctxA.sources.upsertDocument({ ...docA, sourceId: sourceA.id } as SourceDocument);

			const sourcesA = await ctxA.sources.listSources(projA.id);
			const sourcesB = await ctxB.sources.listSources(projB.id);
			assert.equal(sourcesA.length, 1);
			assert.equal(sourcesB.length, 0);
			assert.equal(await ctxB.sources.getSource(sourceA.id), null);

			const docsA = await ctxA.sources.listDocuments(sourceA.id);
			const docsB = await ctxB.sources.listDocuments(sourceA.id);
			assert.equal(docsA.length, 1);
			assert.equal(docsB.length, 0);
		});
	});

	describe("Project-Keyed Audit Locks Concurrency", () => {
		test("serializes concurrent operations on the same project", async () => {
			const lockA = getProjectAuditLock("proj_lock_test_1");
			const order: string[] = [];

			const task1 = lockA(async () => {
				order.push("t1_start");
				await new Promise((resolve) => setTimeout(resolve, 50));
				order.push("t1_end");
			});

			const task2 = lockA(async () => {
				order.push("t2_start");
				order.push("t2_end");
			});

			await Promise.all([task1, task2]);

			assert.deepEqual(order, ["t1_start", "t1_end", "t2_start", "t2_end"]);
		});

		test("allows concurrent operations across distinct projects to run in parallel without blocking", async () => {
			const lockA = getProjectAuditLock("proj_parallel_A");
			const lockB = getProjectAuditLock("proj_parallel_B");

			const events: string[] = [];

			// Project A operation takes 80ms
			const taskA = lockA(async () => {
				events.push("A_start");
				await new Promise((resolve) => setTimeout(resolve, 80));
				events.push("A_end");
			});

			// Small delay before starting Project B so A is definitely running
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Project B operation is quick (10ms) and must finish BEFORE Project A finishes
			const taskB = lockB(async () => {
				events.push("B_start");
				await new Promise((resolve) => setTimeout(resolve, 10));
				events.push("B_end");
			});

			await Promise.all([taskA, taskB]);

			// Project B started and finished while Project A was still running!
			assert.ok(events.indexOf("B_start") !== -1);
			assert.ok(events.indexOf("B_end") < events.indexOf("A_end"));
			assert.deepEqual(events, ["A_start", "B_start", "B_end", "A_end"]);
		});
	});

	describe("Store Factory Implementations & Atomic Writes", () => {
		test("createChatStore writes atomically and handles CRUD operations", () => {
			const chatsDir = path.join(tempDir, "chats");
			const store = createChatStore(chatsDir);

			const chat = store.createChat("Atomic Chat Test");
			assert.ok(chat.id);
			assert.equal(chat.title, "Atomic Chat Test");

			const file = path.join(chatsDir, `${chat.id}.json`);
			assert.ok(fs.existsSync(file));

			// Verify atomic replacement
			store.renameChat(chat.id, "Renamed Atomic Chat");
			const fetched = store.getChat(chat.id);
			assert.equal(fetched?.title, "Renamed Atomic Chat");

			// Verify no temporary files remain
			const files = fs.readdirSync(chatsDir);
			assert.ok(files.every((f) => !f.includes(".tmp")));

			assert.equal(store.deleteChat(chat.id), true);
			assert.equal(store.getChat(chat.id), null);
		});

		test("createGraphStore performs atomic ledger writes", () => {
			const graphDir = path.join(tempDir, "graph");
			const store = createGraphStore(graphDir);

			const node: GraphNode = {
				id: "n1",
				name: "Proving",
				statement: "Proofs verify mathematical propositions.",
				aliases: [],
				createdAt: new Date().toISOString(),
				provenance: [],
			};
			store.appendNode(node);

			assert.equal(store.readNodes().length, 1);
			assert.equal(store.readNodes()[0]?.id, "n1");

			store.rewriteLedgers({ nodes: [] });
			assert.equal(store.readNodes().length, 0);

			const files = fs.readdirSync(graphDir);
			assert.ok(files.every((f) => !f.includes(".tmp")));
		});

		test("createJobStore performs atomic job writes", () => {
			const jobsDir = path.join(tempDir, "jobs");
			const store = createJobStore(jobsDir);

			const job = store.createJob({
				chatId: "chat_1",
				kind: "research",
				toolCallId: "call_1",
				activity: "starting",
			});

			assert.equal(store.getJob(job.id)?.status, "running");
			store.updateJob(job.id, { status: "done", activity: "completed" });
			assert.equal(store.getJob(job.id)?.status, "done");

			const files = fs.readdirSync(jobsDir);
			assert.ok(files.every((f) => !f.includes(".tmp")));
		});

		test("createPracticeStore performs atomic problem set writes", async () => {
			const practiceDir = path.join(tempDir, "practice");
			const store = createPracticeStore(practiceDir);

			const pset = await store.createProblemSet({
				projectId: "proj_1",
				title: "Calculus Limits",
				nodeIds: ["node_limit"],
				propositions: { node_limit: { name: "Limit", statement: "Limit behavior as x -> c" } },
				chains: [],
			});

			assert.equal(pset.title, "Calculus Limits");
			const fetched = await store.getProblemSet(pset.id);
			assert.equal(fetched?.id, pset.id);

			await store.updateProblemSet(pset.id, { title: "Calculus Limits & Continuity" });
			const updated = await store.getProblemSet(pset.id);
			assert.equal(updated?.title, "Calculus Limits & Continuity");

			const deleted = await store.deleteProblemSet(pset.id);
			assert.equal(deleted, true);
			assert.equal(await store.getProblemSet(pset.id), null);

			const files = fs.readdirSync(practiceDir);
			assert.ok(files.every((f) => !f.includes(".tmp")));
		});

		test("createSourceStore performs atomic source and document writes", async () => {
			const sourcesDir = path.join(tempDir, "sources");
			const store = createSourceStore(sourcesDir);

			const source = await store.addSource({
				projectId: "proj_1",
				vaultId: "vault_1",
				include: ["**/*.md"],
				exclude: [".obsidian/**"],
				recursive: true,
				enabled: true,
				syncMode: "manual",
				deletionPolicy: "deactivate",
			});

			assert.ok(source.id);
			assert.equal((await store.listSources("proj_1")).length, 1);

			await store.updateSource(source.id, { enabled: false });
			const updated = await store.getSource(source.id);
			assert.equal(updated?.enabled, false);

			const doc: SourceDocument = {
				id: "doc_1",
				vaultId: "vault_1",
				currentPath: "notes/intro.md",
				contentHash: "sha256_intro",
				revisionId: "rev_1",
				status: "active",
			};
			await store.upsertDocument({ ...doc, sourceId: source.id } as SourceDocument);
			assert.equal((await store.listDocuments(source.id)).length, 1);

			await store.removeSource(source.id);
			assert.equal((await store.listSources("proj_1")).length, 0);
			assert.equal((await store.listDocuments(source.id)).length, 0);

			const files = fs.readdirSync(sourcesDir);
			assert.ok(files.every((f) => !f.includes(".tmp")));
		});
	});
});
