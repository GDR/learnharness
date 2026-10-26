import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
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
import { DEFAULT_PROJECT_ID } from "../src/core/contracts/project.ts";

describe("Adversarial Milestone A Slice 2: Lock Contention, Boundary Rejection & 404 Isolation", () => {
	let sandboxDir: string;
	let projectStore: ReturnType<typeof createProjectStore>;

	beforeEach(() => {
		sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-adv-s2-test-"));
		clearProjectContextCache();
		projectStore = createProjectStore(sandboxDir);
	});

	afterEach(() => {
		clearProjectContextCache();
		try {
			fs.rmSync(sandboxDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup error
		}
	});

	describe("Suite 1: Intra-Project Serialization Stress (20 Concurrent Acquisitions)", () => {
		it("strictly serializes 20 concurrent lock acquisitions in FIFO order with zero overlap", async () => {
			const projectId = "proj_test_serial_20";
			const lock = getProjectAuditLock(projectId);
			const CONCURRENCY = 20;

			interface TaskRecord {
				id: number;
				start: bigint;
				end: bigint;
				concurrencyAtStart: number;
			}

			const records: TaskRecord[] = [];
			let activeCount = 0;
			let maxActive = 0;

			const tasks = Array.from({ length: CONCURRENCY }, (_, i) => {
				return lock(async () => {
					activeCount++;
					if (activeCount > maxActive) maxActive = activeCount;
					const concurrencyAtStart = activeCount;
					const start = process.hrtime.bigint();

					await new Promise((r) => setTimeout(r, 6 + (i % 3) * 2));

					const end = process.hrtime.bigint();
					activeCount--;

					records.push({ id: i, start, end, concurrencyAtStart });
				});
			});

			await Promise.all(tasks);

			assert.equal(records.length, CONCURRENCY);
			assert.equal(maxActive, 1, `Max active concurrency inside lock was ${maxActive}, expected 1`);

			for (let i = 0; i < records.length; i++) {
				assert.equal(records[i]!.id, i, `Task ${i} executed out of FIFO order`);
				assert.equal(records[i]!.concurrencyAtStart, 1);
				if (i > 0) {
					assert.ok(
						records[i]!.start >= records[i - 1]!.end,
						`Task ${i} overlapped with task ${i - 1}!`,
					);
				}
			}
		});

		it("survives throwing tasks without corrupting or deadlocking the FIFO lock queue", async () => {
			const projectId = "proj_fault_resilience";
			const lock = getProjectAuditLock(projectId);
			const failing = new Set([2, 5, 8]);
			const executed: number[] = [];
			const failed: number[] = [];

			const tasks = Array.from({ length: 12 }, (_, i) => {
				return lock(async () => {
					if (failing.has(i)) {
						throw new Error(`Intentional error in task ${i}`);
					}
					executed.push(i);
					await new Promise((r) => setTimeout(r, 4));
				}).catch((err) => {
					assert.ok(err.message.includes(`Intentional error in task ${i}`));
					failed.push(i);
				});
			});

			await Promise.all(tasks);

			assert.deepEqual(failed.sort((a, b) => a - b), Array.from(failing).sort((a, b) => a - b));
			const expectedExecuted = Array.from({ length: 12 }, (_, i) => i).filter((i) => !failing.has(i));
			assert.deepEqual(executed, expectedExecuted);
		});
	});

	describe("Suite 2: Cross-Project Parallelism Stress (20 Concurrent Projects)", () => {
		it("runs 20 concurrent lock acquisitions on distinct projects in parallel without blocking", async () => {
			const CONCURRENCY = 20;
			const HOLD_MS = 50;
			let activeCount = 0;
			let peakActive = 0;

			const startWall = Date.now();
			const tasks = Array.from({ length: CONCURRENCY }, (_, i) => {
				const lock = getProjectAuditLock(`proj_par_unit_${i}`);
				return lock(async () => {
					activeCount++;
					if (activeCount > peakActive) peakActive = activeCount;
					await new Promise((r) => setTimeout(r, HOLD_MS));
					activeCount--;
				});
			});

			await Promise.all(tasks);
			const duration = Date.now() - startWall;

			// If serialized: 20 * 50ms = 1000ms. In parallel: ~50-200ms.
			assert.ok(
				duration < 350,
				`Parallel execution took ${duration}ms, expected < 350ms (indicating parallelism)`,
			);
			assert.ok(
				peakActive >= 15,
				`Peak concurrent projects running simultaneously was ${peakActive}, expected >= 15`,
			);
		});
	});

	describe("Suite 3: Boundary Rejection Matrix (validateProjectId, status 400)", () => {
		const boundaryVectors: Array<{ desc: string; val: unknown }> = [
			{ desc: "Path traversal ../", val: "../escape" },
			{ desc: "Path traversal ../../etc", val: "../../etc/passwd" },
			{ desc: "Path traversal /root", val: "/root" },
			{ desc: "Path traversal .", val: "." },
			{ desc: "Path traversal ..", val: ".." },
			{ desc: "Subdirectory slash", val: "proj/sub" },
			{ desc: "Windows backslash", val: "proj\\sub" },
			{ desc: "Null byte", val: "proj\0bad" },
			{ desc: "Null byte only", val: "\0" },
			{ desc: "Empty string", val: "" },
			{ desc: "Whitespace string", val: "   " },
			{ desc: "Newline string", val: "\n" },
			{ desc: "Tab string", val: "\t" },
			{ desc: "Shell injection ;", val: "proj;rm" },
			{ desc: "Shell injection &&", val: "proj&&ls" },
			{ desc: "Shell injection |", val: "proj|sh" },
			{ desc: "Shell injection `", val: "proj`whoami`" },
			{ desc: "Shell injection $()", val: "proj$(id)" },
			{ desc: "Special symbol @", val: "proj@domain" },
			{ desc: "Special symbol #", val: "proj#hash" },
			{ desc: "Special symbol $", val: "proj$money" },
			{ desc: "Special symbol %", val: "proj%pct" },
			{ desc: "Special symbol *", val: "proj*star" },
			{ desc: "Special symbol :", val: "proj:colon" },
			{ desc: "Null type", val: null },
			{ desc: "Undefined type", val: undefined },
			{ desc: "Number type", val: 123 },
			{ desc: "Boolean type", val: false },
			{ desc: "Object type", val: {} },
			{ desc: "Array type", val: ["proj"] },
			{ desc: "Cyrillic unicode", val: "проект_1" },
			{ desc: "Emoji unicode", val: "proj_🚀" },
		];

		for (const { desc, val } of boundaryVectors) {
			it(`rejects [${desc}] with status 400 across all APIs`, async () => {
				// validateProjectId
				assert.throws(
					() => validateProjectId(val),
					(err: unknown) => err instanceof InvalidProjectIdError && err.status === 400,
				);

				// getProjectAuditLock
				assert.throws(
					() => getProjectAuditLock(val),
					(err: unknown) => err instanceof InvalidProjectIdError && err.status === 400,
				);

				// resolveProjectContext
				await assert.rejects(
					async () => {
						await resolveProjectContext(val, { dataDir: sandboxDir, projectStore });
					},
					(err: unknown) => err instanceof InvalidProjectIdError && err.status === 400,
				);
			});
		}
	});

	describe("Suite 4: Non-Existent Project Rejection & Zero Fallback (status 404)", () => {
		it("rejects unknown project IDs with status 404 and does not create directories or fall back", async () => {
			const defaultProject = await projectStore.createProject({
				id: DEFAULT_PROJECT_ID,
				name: "Default Project",
			});
			assert.ok(defaultProject);

			const nonExistentIds = [
				"proj_ghost_1",
				"proj_unknown_999",
				"proj_missing_x",
				"proj_nonexistent_abc",
			];

			for (const id of nonExistentIds) {
				const targetDir = path.join(sandboxDir, "projects", id);
				assert.equal(fs.existsSync(targetDir), false);

				await assert.rejects(
					async () => {
						await resolveProjectContext(id, { dataDir: sandboxDir, projectStore });
					},
					(err: unknown) => {
						return (
							err instanceof ProjectNotFoundError &&
							err.status === 404 &&
							err.projectId === id
						);
					},
				);

				// Invariant: zero directory creation on 404
				assert.equal(
					fs.existsSync(targetDir),
					false,
					`resolveProjectContext must not create directory for non-existent project "${id}"`,
				);
			}
		});
	});

	describe("Suite 5: Context Caching & Lifecycle", () => {
		it("caches context sequentially and invalidates on clearProjectContextCache()", async () => {
			const project = await projectStore.createProject({
				id: "proj_caching_test",
				name: "Caching Test",
			});

			const ctx1 = await resolveProjectContext(project.id, { dataDir: sandboxDir, projectStore });
			const ctx2 = await resolveProjectContext(project.id, { dataDir: sandboxDir, projectStore });
			assert.equal(ctx1, ctx2, "Sequential resolveProjectContext calls must return cached reference");

			clearProjectContextCache();
			const ctx3 = await resolveProjectContext(project.id, { dataDir: sandboxDir, projectStore });
			assert.notEqual(ctx1, ctx3, "clearProjectContextCache must clear the cache");
			assert.equal(ctx3.projectId, project.id);
		});
	});
});
