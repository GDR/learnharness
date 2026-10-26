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

describe("Adversarial Stress-Testing: ProjectContext, Audit Locks & Store Factories", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-adversarial-ctx-"));
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

	describe("validateProjectId Attack Vectors", () => {
		test("rejects various malicious and boundary inputs", () => {
			const hostileInputs = [
				"",
				"   ",
				"\t\n",
				"../traversal",
				"../../etc/passwd",
				"..\\windows\\system32",
				"proj/sub",
				"proj\\sub",
				"proj\0nullbyte",
				"proj\nnewline",
				"proj\rreturn",
				"proj;rm -rf",
				"proj|cat",
				"proj&bg",
				"proj`ls`",
				"proj$(id)",
				"proj name with space",
				"proj@domain.com",
				"proj#hash",
				"proj?query=1",
				"proj:port",
				"proj!bang",
				"proj~home",
				"proj*wildcard",
				"proj[bracket]",
				"proj{brace}",
				"proj<tag>",
				"proj>redirect",
				"🚀_emoji",
				"проект_кириллица",
				"projekt_umlaut_ä",
				null,
				undefined,
				12345,
				true,
				false,
				{},
				[],
				() => {},
				Symbol("proj"),
			];

			for (const input of hostileInputs) {
				assert.throws(
					() => validateProjectId(input),
					(err: unknown) => {
						return err instanceof InvalidProjectIdError && err.status === 400;
					},
					`Expected validateProjectId(${JSON.stringify(input)}) to throw InvalidProjectIdError with status 400`,
				);
			}
		});

		test("handles very long valid ID without exponential blowup", () => {
			const longId = "proj_" + "a".repeat(5000);
			const validated = validateProjectId(longId);
			assert.equal(validated, longId);
		});
	});

	describe("resolveProjectContext Edge Cases & Cache Isolation", () => {
		test("cache keys properly isolate different dataDirs for identical project IDs", async () => {
			const dirA = path.join(tempDir, "dataDirA");
			const dirB = path.join(tempDir, "dataDirB");
			fs.mkdirSync(dirA, { recursive: true });
			fs.mkdirSync(dirB, { recursive: true });

			const storeA = createProjectStore(dirA);
			const storeB = createProjectStore(dirB);

			await storeA.createProject({ id: "shared_id", name: "Project in A" });
			await storeB.createProject({ id: "shared_id", name: "Project in B" });

			const ctxA = await resolveProjectContext("shared_id", { dataDir: dirA, projectStore: storeA });
			const ctxB = await resolveProjectContext("shared_id", { dataDir: dirB, projectStore: storeB });

			assert.notEqual(ctxA, ctxB);

			// Write in ctxA
			const chatA = ctxA.chats.createChat("Chat A");
			assert.ok(fs.existsSync(path.join(dirA, "projects", "shared_id", "chats", `${chatA.id}.json`)));
			assert.ok(!fs.existsSync(path.join(dirB, "projects", "shared_id", "chats", `${chatA.id}.json`)));
		});

		test("concurrent resolveProjectContext requests for the same project all resolve valid contexts (with subsequent reference caching)", async () => {
			const store = createProjectStore(tempDir);
			const p = await store.createProject({ id: "proj_concurrent", name: "Concurrent Test" });

			const promises = Array.from({ length: 30 }, () =>
				resolveProjectContext(p.id, { dataDir: tempDir, projectStore: store }),
			);

			const results = await Promise.all(promises);
			assert.equal(results.length, 30);
			for (const r of results) {
				assert.equal(r.projectId, p.id);
				assert.strictEqual(r, results[0]);
				assert.ok(r.chats);
				assert.ok(r.graph);
				assert.ok(r.jobs);
				assert.ok(r.practice);
				assert.ok(r.sources);
			}

			// Once cache is populated, subsequent resolutions are strictly reference-equal
			const post1 = await resolveProjectContext(p.id, { dataDir: tempDir, projectStore: store });
			const post2 = await resolveProjectContext(p.id, { dataDir: tempDir, projectStore: store });
			assert.equal(post1, post2);
		});

		test("rejects unknown project without falling back to any existing project", async () => {
			const store = createProjectStore(tempDir);
			await store.createProject({ id: "proj_exists", name: "Existing Project" });

			await assert.rejects(
				async () => {
					await resolveProjectContext("proj_does_not_exist", { dataDir: tempDir, projectStore: store });
				},
				(err: unknown) => {
					return err instanceof ProjectNotFoundError && err.status === 404 && err.projectId === "proj_does_not_exist";
				},
			);
		});
	});

	describe("getProjectAuditLock Mutex & FIFO Concurrency Stress-Testing", () => {
		test("maintains strict FIFO order across 40 concurrently queued tasks", async () => {
			const lock = getProjectAuditLock("proj_fifo_stress");
			const executionOrder: number[] = [];
			const numTasks = 40;

			const tasks = Array.from({ length: numTasks }, (_, i) => {
				return lock(async () => {
					// Add variable micro-delays
					await new Promise((resolve) => setTimeout(resolve, (i % 3) + 1));
					executionOrder.push(i);
				});
			});

			await Promise.all(tasks);
			assert.equal(executionOrder.length, numTasks);
			for (let i = 0; i < numTasks; i++) {
				assert.equal(executionOrder[i], i, `Task at index ${i} did not execute in FIFO order`);
			}
		});

		test("lock does not deadlock or poison when an intermediate task throws an exception", async () => {
			const lock = getProjectAuditLock("proj_error_recovery");
			const order: string[] = [];

			const t1 = lock(async () => {
				order.push("t1_done");
			});

			const t2_failing_async = lock(async () => {
				order.push("t2_failing_async");
				throw new Error("async failure in t2");
			});

			const t3_failing_sync = lock(() => {
				order.push("t3_failing_sync");
				throw new Error("sync failure in t3");
			});

			const t4 = lock(async () => {
				order.push("t4_done");
			});

			await t1;
			await assert.rejects(t2_failing_async, /async failure in t2/);
			await assert.rejects(t3_failing_sync, /sync failure in t3/);
			await t4;

			assert.deepEqual(order, ["t1_done", "t2_failing_async", "t3_failing_sync", "t4_done"]);
		});

		test("different project audit locks run concurrently without blocking each other", async () => {
			const lockP1 = getProjectAuditLock("proj_par_1");
			const lockP2 = getProjectAuditLock("proj_par_2");
			const trace: string[] = [];

			const p1Task = lockP1(async () => {
				trace.push("p1_start");
				await new Promise((resolve) => setTimeout(resolve, 60));
				trace.push("p1_end");
			});

			await new Promise((resolve) => setTimeout(resolve, 10));

			const p2Task = lockP2(async () => {
				trace.push("p2_start");
				await new Promise((resolve) => setTimeout(resolve, 10));
				trace.push("p2_end");
			});

			await Promise.all([p1Task, p2Task]);

			// p2 must finish before p1 finishes
			assert.ok(trace.indexOf("p2_end") < trace.indexOf("p1_end"));
			assert.deepEqual(trace, ["p1_start", "p2_start", "p2_end", "p1_end"]);
		});
	});

	describe("Store Factories POSIX Atomic Writes & Integrity", () => {
		test("createPracticeStore problem set operations", async () => {
			const pDir = path.join(tempDir, "practice");
			const store = createPracticeStore(pDir);

			const pset = await store.createProblemSet({
				projectId: "proj_test",
				title: "Quantum Mechanics",
				nodeIds: ["node_qm_1"],
				propositions: { node_qm_1: { name: "Wavefunction", statement: "Psi represents probability amplitude" } },
				chains: [],
			});

			assert.equal(pset.title, "Quantum Mechanics");
			assert.equal(pset.status, "active");

			// List
			const list = await store.listProblemSets("proj_test");
			assert.equal(list.length, 1);

			// Update
			const updated = await store.updateProblemSet(pset.id, { title: "QM & Operators" });
			assert.equal(updated?.title, "QM & Operators");

			// Delete
			const deleted = await store.deleteProblemSet(pset.id);
			assert.equal(deleted, true);
			assert.equal(await store.getProblemSet(pset.id), null);
		});

		test("createSourceStore sources & document inventory operations", async () => {
			const sDir = path.join(tempDir, "sources");
			const store = createSourceStore(sDir);

			const src = await store.addSource({
				projectId: "proj_test",
				vaultId: "vault_1",
				include: ["**/*.md"],
				exclude: [".git/**"],
				recursive: true,
				enabled: true,
				syncMode: "manual",
				deletionPolicy: "retain",
			});

			assert.ok(src.id);
			assert.equal(src.projectId, "proj_test");

			// Upsert document
			await store.upsertDocument({
				id: "doc_100",
				vaultId: "vault_1",
				sourceId: src.id,
				currentPath: "notes/qm.md",
				contentHash: "hash100",
				revisionId: "rev1",
				status: "active",
			});

			const docs = await store.listDocuments(src.id);
			assert.equal(docs.length, 1);
			assert.equal(docs[0]?.id, "doc_100");

			// Remove source cascades to docs
			await store.removeSource(src.id);
			assert.equal((await store.listSources("proj_test")).length, 0);
			assert.equal((await store.listDocuments(src.id)).length, 0);
		});
	});
});
