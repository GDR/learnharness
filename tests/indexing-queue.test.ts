import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
	type IndexingJob,
	validateIndexingJob,
	IndexingConflictError,
	IndexingJobNotFoundError,
	IndexingNotFoundError,
	triggerIndexingRequestSchema,
	sourceIndexingStatusResponseSchema,
	projectIndexingStatusResponseSchema,
} from "../src/core/contracts/indexing.ts";
import {
	IndexingQueue,
	getIndexingQueue,
	setIndexingQueue,
	VaultUnavailableError,
	createVaultRegistry,
	setVaultRegistry,
	createProjectStore,
	setProjectStore,
	clearProjectContextCache,
} from "../src/server/index.ts";
import {
	POST as postSourceIndexRoute,
	GET as getSourceIndexRoute,
	DELETE as deleteSourceIndexRoute,
} from "../app/api/projects/[id]/sources/[sourceId]/index/route.ts";
import {
	GET as getProjectIndexStatusRoute,
} from "../app/api/projects/[id]/index/status/route.ts";

test("Milestone C Slice 3: Durable Indexing State Machine & Queue", async (t) => {
	let tmpDir = "";
	let vaultFolder = "";

	function setup() {
		clearProjectContextCache();
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-indexing-test-"));
		vaultFolder = path.join(tmpDir, "vault");
		fs.mkdirSync(vaultFolder, { recursive: true });

		const vRegistry = createVaultRegistry(tmpDir);
		setVaultRegistry(vRegistry);

		const pStore = createProjectStore(tmpDir);
		setProjectStore(pStore);

		setIndexingQueue(null);
	}

	function teardown() {
		clearProjectContextCache();
		setVaultRegistry(null);
		setProjectStore(null);
		setIndexingQueue(null);
		try {
			if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup error
		}
	}

	await t.test("Suite 1: Contracts & Validation", () => {
		const validJob: IndexingJob = {
			id: "job_123",
			projectId: "proj_valid",
			sourceId: "src_valid",
			state: "queued",
			progress: {
				current: 0,
				total: 10,
				processedDocuments: 0,
				totalDocuments: 10,
				percent: 0,
				stage: "queued",
				currentStage: "queued",
			},
			stats: {
				added: 2,
				modified: 1,
				unchanged: 5,
				removed: 0,
				extractedPropositions: 8,
				elapsedMs: 120,
				scannedCount: 8,
				addedCount: 2,
				modifiedCount: 1,
				unchangedCount: 5,
				removedCount: 0,
				chunksCreated: 8,
				durationMs: 120,
			},
			startedAt: "2026-10-27T00:00:00.000Z",
			createdAt: "2026-10-27T00:00:00.000Z",
			updatedAt: "2026-10-27T00:00:00.000Z",
		};

		// Accepts valid job
		const parsed = validateIndexingJob(validJob);
		assert.equal(parsed.id, "job_123");
		assert.equal(parsed.state, "queued");

		// Accepts all lifecycle states
		const states = [
			"queued",
			"scanning",
			"extracting",
			"validating",
			"committing",
			"completed",
			"failed",
			"canceled",
		] as const;
		for (const st of states) {
			const j = { ...validJob, state: st };
			assert.equal(validateIndexingJob(j).state, st);
		}

		// Rejects negative progress numbers
		assert.throws(() => {
			validateIndexingJob({
				...validJob,
				progress: { ...validJob.progress, current: -1 },
			});
		});

		// Rejects negative stats numbers
		assert.throws(() => {
			validateIndexingJob({
				...validJob,
				stats: { ...validJob.stats, added: -5 },
			});
		});

		// Rejects empty ID
		assert.throws(() => {
			validateIndexingJob({
				...validJob,
				id: "",
			});
		});

		// Error classes verification
		const conflictErr = new IndexingConflictError("p1", "s1", "j_active");
		assert.equal(conflictErr.status, 409);
		assert.equal(conflictErr.code, "INDEXING_CONFLICT");
		assert.equal(conflictErr.activeJobId, "j_active");

		const notFoundErr = new IndexingJobNotFoundError("j_missing");
		assert.equal(notFoundErr.status, 404);
		assert.equal(notFoundErr.code, "JOB_NOT_FOUND");
		assert.equal(notFoundErr.jobId, "j_missing");

		assert.equal(IndexingNotFoundError, IndexingJobNotFoundError);

		// Schema validations
		assert.ok(triggerIndexingRequestSchema.safeParse({ forceRescan: true }).success);
		assert.ok(triggerIndexingRequestSchema.safeParse({}).success);
		assert.ok(
			sourceIndexingStatusResponseSchema.safeParse({
				activeJob: validJob,
				latestJob: null,
				recentJobs: [validJob],
			}).success,
		);
		assert.ok(
			projectIndexingStatusResponseSchema.safeParse({
				activeJobs: [validJob],
				queuedJobs: [],
				concurrency: {
					activeCount: 1,
					queuedCount: 0,
					maxConcurrency: 3,
				},
				recentJobs: [],
			}).success,
		);
	});

	await t.test("Suite 2: Bounded Concurrency (Max 3 Active Jobs)", async () => {
		setup();
		try {
			const pStore = createProjectStore(tmpDir);
			await pStore.createProject({ id: "proj_concur", name: "Concurrency Project" });

			const vRegistry = createVaultRegistry(tmpDir);
			const vault = await vRegistry.registerVault({
				id: "vault_concur",
				displayName: "Vault Concur",
				kind: "obsidian",
				bindings: [{ deviceId: "local", rootPath: vaultFolder, status: "available" }],
			});

			const context = await (await import("../src/server/projects.ts")).resolveProjectContext("proj_concur", { dataDir: tmpDir });

			// Add 4 sources
			const s1 = await context.sources.addSource({
				projectId: "proj_concur",
				vaultId: vault.id,
				include: ["s1/**/*.md"],
				exclude: [],
				recursive: true,
				enabled: true,
				syncMode: "manual",
				deletionPolicy: "deactivate",
			});
			const s2 = await context.sources.addSource({
				projectId: "proj_concur",
				vaultId: vault.id,
				include: ["s2/**/*.md"],
				exclude: [],
				recursive: true,
				enabled: true,
				syncMode: "manual",
				deletionPolicy: "deactivate",
			});
			const s3 = await context.sources.addSource({
				projectId: "proj_concur",
				vaultId: vault.id,
				include: ["s3/**/*.md"],
				exclude: [],
				recursive: true,
				enabled: true,
				syncMode: "manual",
				deletionPolicy: "deactivate",
			});
			const s4 = await context.sources.addSource({
				projectId: "proj_concur",
				vaultId: vault.id,
				include: ["s4/**/*.md"],
				exclude: [],
				recursive: true,
				enabled: true,
				syncMode: "manual",
				deletionPolicy: "deactivate",
			});

			// Write empty files for each source
			for (const dir of ["s1", "s2", "s3", "s4"]) {
				const dPath = path.join(vaultFolder, dir);
				fs.mkdirSync(dPath, { recursive: true });
				fs.writeFileSync(path.join(dPath, "note.md"), `# Title in ${dir}\nContent`);
			}

			let resolveDeferred1: () => void = () => {};
			const deferred1 = new Promise<void>((r) => {
				resolveDeferred1 = r;
			});

			const queue = new IndexingQueue(3);
			assert.equal(queue.getMaxConcurrency(), 3);

			// Trigger 3 jobs held by hooks
			const job1 = await queue.triggerIndexing({
				projectId: "proj_concur",
				sourceId: s1.id,
				dataDir: tmpDir,
				projectStore: pStore,
				vaultRegistry: vRegistry,
				hooks: {
					onValidate: async () => {
						await deferred1;
					},
				},
			});

			let resolveDeferredRest: () => void = () => {};
			const deferredRest = new Promise<void>((r) => {
				resolveDeferredRest = r;
			});

			const job2 = await queue.triggerIndexing({
				projectId: "proj_concur",
				sourceId: s2.id,
				dataDir: tmpDir,
				projectStore: pStore,
				vaultRegistry: vRegistry,
				hooks: {
					onValidate: async () => {
						await deferredRest;
					},
				},
			});

			const job3 = await queue.triggerIndexing({
				projectId: "proj_concur",
				sourceId: s3.id,
				dataDir: tmpDir,
				projectStore: pStore,
				vaultRegistry: vRegistry,
				hooks: {
					onValidate: async () => {
						await deferredRest;
					},
				},
			});

			// Wait a tick for async promises to transition to active
			await new Promise((r) => setTimeout(r, 50));

			assert.equal(queue.getActiveJobsCount(), 3);
			assert.equal(queue.getQueuedJobsCount(), 0);

			// Trigger 4th job -> must be queued!
			const job4 = await queue.triggerIndexing({
				projectId: "proj_concur",
				sourceId: s4.id,
				dataDir: tmpDir,
				projectStore: pStore,
				vaultRegistry: vRegistry,
			});

			assert.equal(job4.state, "queued");
			assert.equal(queue.getQueuedJobsCount(), 1);
			assert.equal(queue.getActiveJobsCount(), 3);

			// Now release Job 1 -> finishes, allowing Job 4 to drain into active
			resolveDeferred1();

			// Poll until Job 1 is completed
			let pollCount = 0;
			while (job1.state !== "completed" && pollCount < 50) {
				await new Promise((r) => setTimeout(r, 50));
				pollCount++;
			}
			assert.equal(job1.state, "completed");

			// Now Job 4 should have started or finished
			let pollCount4 = 0;
			while ((job4 as IndexingJob).state === "queued" && pollCount4 < 50) {
				await new Promise((r) => setTimeout(r, 50));
				pollCount4++;
			}
			assert.notEqual((job4 as IndexingJob).state, "queued");

			// Release rest and await all jobs before teardown
			resolveDeferredRest();
			while (
				(job2.state !== "completed" && job2.state !== "failed") ||
				(job3.state !== "completed" && job3.state !== "failed") ||
				((job4 as IndexingJob).state !== "completed" && (job4 as IndexingJob).state !== "failed")
			) {
				await new Promise((r) => setTimeout(r, 20));
			}
		} finally {
			teardown();
		}
	});

	await t.test("Suite 3: Per-Source Serialization (409 Conflict)", async () => {
		setup();
		try {
			const pStore = createProjectStore(tmpDir);
			await pStore.createProject({ id: "proj_mutex", name: "Mutex Project" });

			const vRegistry = createVaultRegistry(tmpDir);
			const vault = await vRegistry.registerVault({
				id: "vault_mutex",
				displayName: "Vault Mutex",
				kind: "obsidian",
				bindings: [{ deviceId: "local", rootPath: vaultFolder, status: "available" }],
			});

			const context = await (await import("../src/server/projects.ts")).resolveProjectContext("proj_mutex", { dataDir: tmpDir });
			const src = await context.sources.addSource({
				projectId: "proj_mutex",
				vaultId: vault.id,
				include: ["**/*.md"],
				exclude: [],
				recursive: true,
				enabled: true,
				syncMode: "manual",
				deletionPolicy: "deactivate",
			});

			fs.writeFileSync(path.join(vaultFolder, "doc.md"), "# Single Doc\nContent");

			let resolveDeferred: () => void = () => {};
			const deferred = new Promise<void>((r) => {
				resolveDeferred = r;
			});

			const queue = new IndexingQueue(3);

			// Start Job 1 held in validating hook
			const job1 = await queue.triggerIndexing({
				projectId: "proj_mutex",
				sourceId: src.id,
				dataDir: tmpDir,
				projectStore: pStore,
				vaultRegistry: vRegistry,
				hooks: {
					onValidate: async () => {
						await deferred;
					},
				},
			});

			assert.ok(job1.id);

			// Triggering again on same source MUST reject with IndexingConflictError (409)
			await assert.rejects(
				async () => {
					await queue.triggerIndexing({
						projectId: "proj_mutex",
						sourceId: src.id,
						dataDir: tmpDir,
						projectStore: pStore,
						vaultRegistry: vRegistry,
					});
				},
				(err: unknown) => {
					assert.ok(err instanceof IndexingConflictError);
					assert.equal(err.status, 409);
					assert.equal(err.activeJobId, job1.id);
					return true;
				},
			);

			// Release Job 1
			resolveDeferred();

			while (queue.getActiveJobForSource("proj_mutex", src.id) || job1.state !== "completed") {
				if (job1.state === "failed") throw new Error(`Job1 failed: ${job1.error}`);
				await new Promise((r) => setTimeout(r, 20));
			}
			assert.equal(job1.state, "completed");

			// Triggering again after completion succeeds cleanly
			const job2 = await queue.triggerIndexing({
				projectId: "proj_mutex",
				sourceId: src.id,
				dataDir: tmpDir,
				projectStore: pStore,
				vaultRegistry: vRegistry,
			});
			assert.ok(job2.id);
			assert.notEqual(job2.id, job1.id);

			while (queue.getActiveJobForSource("proj_mutex", src.id) || (job2.state !== "completed" && job2.state !== "failed")) {
				await new Promise((r) => setTimeout(r, 20));
			}

			// Subtest: Sequential release without lock stealing under persist delay
			let persistDelayMs = 0;
			const originalPersist = queue.persistJob.bind(queue);
			queue.persistJob = async (job, dataDir) => {
				if (persistDelayMs > 0 && job.state === "completed") {
					await new Promise((r) => setTimeout(r, persistDelayMs));
				}
				return originalPersist(job, dataDir);
			};

			persistDelayMs = 50;
			const raceJob1 = await queue.triggerIndexing({
				projectId: "proj_mutex",
				sourceId: src.id,
				dataDir: tmpDir,
				projectStore: pStore,
				vaultRegistry: vRegistry,
			});

			// Wait until raceJob1 is in completed state (it is now executing persistJob with delay)
			while (raceJob1.state !== "completed") {
				await new Promise((r) => setTimeout(r, 10));
			}

			// During persistJob delay, lock must STILL be held! A trigger MUST reject with 409:
			await assert.rejects(
				async () => {
					await queue.triggerIndexing({
						projectId: "proj_mutex",
						sourceId: src.id,
						dataDir: tmpDir,
						projectStore: pStore,
						vaultRegistry: vRegistry,
					});
				},
				(err: unknown) => {
					assert.ok(err instanceof IndexingConflictError);
					assert.equal(err.status, 409);
					assert.equal(err.activeJobId, raceJob1.id);
					return true;
				},
			);

			// Now wait until raceJob1's persistJob finishes and finally block runs
			while (queue.getActiveJobForSource("proj_mutex", src.id)) {
				await new Promise((r) => setTimeout(r, 10));
			}

			// Now raceJob2 can acquire the lock
			let resolveRaceDeferred: () => void = () => {};
			const raceDeferred = new Promise<void>((r) => {
				resolveRaceDeferred = r;
			});

			const raceJob2 = await queue.triggerIndexing({
				projectId: "proj_mutex",
				sourceId: src.id,
				dataDir: tmpDir,
				projectStore: pStore,
				vaultRegistry: vRegistry,
				hooks: {
					onValidate: async () => {
						await raceDeferred;
					},
				},
			});
			assert.ok(raceJob2.id);

			// Verify raceJob1's terminal finally did not wipe raceJob2's active lock:
			// A third job on same source MUST reject with 409 activeJobId === raceJob2.id
			await assert.rejects(
				async () => {
					await queue.triggerIndexing({
						projectId: "proj_mutex",
						sourceId: src.id,
						dataDir: tmpDir,
						projectStore: pStore,
						vaultRegistry: vRegistry,
					});
				},
				(err: unknown) => {
					assert.ok(err instanceof IndexingConflictError);
					assert.equal(err.status, 409);
					assert.equal(err.activeJobId, raceJob2.id);
					return true;
				},
			);

			// Release raceJob2 and wait for full completion
			resolveRaceDeferred();
			while (queue.getActiveJobForSource("proj_mutex", src.id) || (raceJob2.state !== "completed" && raceJob2.state !== "failed")) {
				await new Promise((r) => setTimeout(r, 20));
			}
			assert.equal(raceJob2.state, "completed");

			persistDelayMs = 0;
		} finally {
			teardown();
		}
	});

	await t.test("Suite 4: State Machine Lifecycle Progression & Diff Statistics", async () => {
		setup();
		try {
			const pStore = createProjectStore(tmpDir);
			await pStore.createProject({ id: "proj_lifecycle", name: "Lifecycle Project" });

			const vRegistry = createVaultRegistry(tmpDir);
			const vault = await vRegistry.registerVault({
				id: "vault_lifecycle",
				displayName: "Vault Lifecycle",
				kind: "obsidian",
				bindings: [{ deviceId: "local", rootPath: vaultFolder, status: "available" }],
			});

			const context = await (await import("../src/server/projects.ts")).resolveProjectContext("proj_lifecycle", { dataDir: tmpDir });
			const src = await context.sources.addSource({
				projectId: "proj_lifecycle",
				vaultId: vault.id,
				include: ["**/*.md"],
				exclude: [],
				recursive: true,
				enabled: true,
				syncMode: "manual",
				deletionPolicy: "deactivate",
			});

			// Setup initial state: Note1 and Note2
			fs.writeFileSync(path.join(vaultFolder, "Note1.md"), "# Original Note 1\nContent 1");
			fs.writeFileSync(path.join(vaultFolder, "Note2.md"), "# Original Note 2\nContent 2");

			const queue = new IndexingQueue(3);

			// First run: both notes added
			const initJob = await queue.triggerIndexing({
				projectId: "proj_lifecycle",
				sourceId: src.id,
				dataDir: tmpDir,
				projectStore: pStore,
				vaultRegistry: vRegistry,
			});

			while (queue.getActiveJobForSource("proj_lifecycle", src.id) || initJob.state !== "completed") {
				await new Promise((r) => setTimeout(r, 20));
			}
			assert.equal(initJob.state, "completed");
			assert.equal(initJob.stats.added, 2);

			// Now:
			// - Modify Note1
			// - Leave Note2 unchanged
			// - Add Note3
			fs.writeFileSync(path.join(vaultFolder, "Note1.md"), "# Modified Note 1\nUpdated Content with [[WikiLink]]");
			fs.writeFileSync(path.join(vaultFolder, "Note3.md"), "# Brand New Note 3\nFresh Content with LaTeX $E=mc^2$");

			const observedStages: string[] = [];
			const job = await queue.triggerIndexing({
				projectId: "proj_lifecycle",
				sourceId: src.id,
				dataDir: tmpDir,
				projectStore: pStore,
				vaultRegistry: vRegistry,
				hooks: {
					onValidate: async (ctx) => {
						observedStages.push("validating");
						assert.ok(ctx.extractedChunks.length > 0);
					},
					onCommit: async () => {
						observedStages.push("committing");
					},
				},
			});

			// Observe progression
			while (queue.getActiveJobForSource("proj_lifecycle", src.id) || job.state !== "completed") {
				if (!observedStages.includes(job.state)) {
					observedStages.push(job.state);
				}
				await new Promise((r) => setTimeout(r, 20));
			}

			assert.equal(job.state, "completed");
			assert.ok(job.completedAt);
			assert.ok(job.stats.elapsedMs >= 0);
			assert.equal(job.progress.percent, 100);

			// Check diff counters: 1 added (Note3), 1 modified (Note1), 1 unchanged (Note2)
			assert.equal(job.stats.added, 1);
			assert.equal(job.stats.modified, 1);
			assert.equal(job.stats.unchanged, 1);
			assert.equal(job.stats.removed, 0);

			// Check propositions / chunks
			assert.ok(job.stats.extractedPropositions > 0);
			assert.ok((job.stats.chunksCreated ?? 0) > 0);

			// Verify durable file persisted on disk
			const stored = await queue.getIndexingJob("proj_lifecycle", job.id, tmpDir);
			assert.ok(stored);
			assert.equal(stored.id, job.id);
			assert.equal(stored.state, "completed");
			assert.equal(stored.stats.added, 1);
			assert.equal(stored.stats.modified, 1);

			// Subtest: Re-indexing with 0 modifications extracts 0 notes
			const noModJob = await queue.triggerIndexing({
				projectId: "proj_lifecycle",
				sourceId: src.id,
				dataDir: tmpDir,
				projectStore: pStore,
				vaultRegistry: vRegistry,
			});

			while (queue.getActiveJobForSource("proj_lifecycle", src.id) || (noModJob.state !== "completed" && noModJob.state !== "failed")) {
				await new Promise((r) => setTimeout(r, 20));
			}

			assert.equal(noModJob.state, "completed");
			assert.equal(noModJob.stats.added, 0);
			assert.equal(noModJob.stats.modified, 0);
			assert.equal(noModJob.stats.unchanged, 3);
			assert.equal(noModJob.stats.chunksCreated, 0);
			assert.equal(noModJob.progress.totalDocuments, 0);

			// Subtest: forceRescan re-extracts all 3 notes
			const forceJob = await queue.triggerIndexing({
				projectId: "proj_lifecycle",
				sourceId: src.id,
				forceRescan: true,
				dataDir: tmpDir,
				projectStore: pStore,
				vaultRegistry: vRegistry,
			});

			while (queue.getActiveJobForSource("proj_lifecycle", src.id) || (forceJob.state !== "completed" && forceJob.state !== "failed")) {
				await new Promise((r) => setTimeout(r, 20));
			}

			assert.equal(forceJob.state, "completed");
			assert.equal(forceJob.progress.totalDocuments, 3);
			assert.ok((forceJob.stats.chunksCreated ?? 0) > 0);
		} finally {
			teardown();
		}
	});

	await t.test("Suite 5: Cancellation with AbortController", async () => {
		setup();
		try {
			const pStore = createProjectStore(tmpDir);
			await pStore.createProject({ id: "proj_cancel", name: "Cancel Project" });

			const vRegistry = createVaultRegistry(tmpDir);
			const vault = await vRegistry.registerVault({
				id: "vault_cancel",
				displayName: "Vault Cancel",
				kind: "obsidian",
				bindings: [{ deviceId: "local", rootPath: vaultFolder, status: "available" }],
			});

			const context = await (await import("../src/server/projects.ts")).resolveProjectContext("proj_cancel", { dataDir: tmpDir });
			const src = await context.sources.addSource({
				projectId: "proj_cancel",
				vaultId: vault.id,
				include: ["**/*.md"],
				exclude: [],
				recursive: true,
				enabled: true,
				syncMode: "manual",
				deletionPolicy: "deactivate",
			});

			// Write several notes
			for (let i = 0; i < 5; i++) {
				fs.writeFileSync(path.join(vaultFolder, `note_${i}.md`), `# Note ${i}\nLong body ${i}`);
			}

			let resolveDeferred: () => void = () => {};
			const deferred = new Promise<void>((r) => {
				resolveDeferred = r;
			});

			const queue = new IndexingQueue(3);

			const job = await queue.triggerIndexing({
				projectId: "proj_cancel",
				sourceId: src.id,
				dataDir: tmpDir,
				projectStore: pStore,
				vaultRegistry: vRegistry,
				hooks: {
					onValidate: async ({ signal }) => {
						if (signal?.aborted) return;
						await new Promise<void>((resolve) => {
							signal?.addEventListener("abort", () => resolve(), { once: true });
							deferred.then(() => resolve());
						});
					},
				},
			});

			// Wait until validating
			while (job.state !== "validating") {
				if (job.state === "failed") {
					throw new Error(`Job failed: ${job.error}`);
				}
				await new Promise((r) => setTimeout(r, 20));
			}

			// Cancel job
			const canceled = await queue.cancelIndexingJob("proj_cancel", job.id, tmpDir);
			resolveDeferred();

			assert.equal(canceled.state, "canceled");
			assert.ok(canceled.completedAt);
			assert.ok(canceled.canceledAt);

			// Lock should be released: triggering on source again succeeds immediately
			const nextJob = await queue.triggerIndexing({
				projectId: "proj_cancel",
				sourceId: src.id,
				dataDir: tmpDir,
				projectStore: pStore,
				vaultRegistry: vRegistry,
			});
			assert.ok(nextJob.id);
			while (nextJob.state !== "completed" && nextJob.state !== "failed" && nextJob.state !== "canceled") {
				await new Promise((r) => setTimeout(r, 20));
			}

			// Test cancelling a job while it is still in queued state
			const queue1 = new IndexingQueue(1);
			let resolveBlock: () => void = () => {};
			const blockPromise = new Promise<void>((r) => {
				resolveBlock = r;
			});
			const blockingJob = await queue1.triggerIndexing({
				projectId: "proj_cancel",
				sourceId: src.id,
				dataDir: tmpDir,
				projectStore: pStore,
				vaultRegistry: vRegistry,
				hooks: {
					onValidate: async () => {
						await blockPromise;
					},
				},
			});

			const src2 = await context.sources.addSource({
				projectId: "proj_cancel",
				vaultId: vault.id,
				include: ["src2/**/*.md"],
				exclude: [],
				recursive: true,
				enabled: true,
				syncMode: "manual",
				deletionPolicy: "deactivate",
			});

			const queuedJ = await queue1.triggerIndexing({
				projectId: "proj_cancel",
				sourceId: src2.id,
				dataDir: tmpDir,
				projectStore: pStore,
				vaultRegistry: vRegistry,
			});
			assert.equal(queuedJ.state, "queued");

			const canceledQueued = await queue1.cancelIndexingJob("proj_cancel", queuedJ.id, tmpDir);
			assert.equal(canceledQueued.state, "canceled");
			assert.equal(queue1.getQueuedJobsCount(), 0);

			resolveBlock();
			while (blockingJob.state !== "completed" && blockingJob.state !== "failed") {
				await new Promise((r) => setTimeout(r, 20));
			}
		} finally {
			teardown();
		}
	});

	await t.test("Suite 6: Startup Crash Recovery for Orphaned Jobs", async () => {
		setup();
		try {
			const queue = new IndexingQueue(3);

			// Simulate interrupted jobs on disk
			const idxDir = path.join(tmpDir, "projects", "proj_crash", "indexing");
			fs.mkdirSync(idxDir, { recursive: true });

			const orphanJob1: IndexingJob = {
				id: "job_orphan_1",
				projectId: "proj_crash",
				sourceId: "src_1",
				state: "extracting",
				progress: {
					current: 2,
					total: 10,
					currentStage: "extracting",
				},
				stats: {
					added: 2,
					modified: 0,
					unchanged: 0,
					removed: 0,
					extractedPropositions: 5,
					elapsedMs: 250,
				},
				startedAt: "2026-10-27T02:00:00.000Z",
			};

			const orphanJob2: IndexingJob = {
				id: "job_orphan_2",
				projectId: "proj_crash",
				sourceId: "src_2",
				state: "validating",
				progress: {
					current: 5,
					total: 5,
					currentStage: "validating",
				},
				stats: {
					added: 5,
					modified: 0,
					unchanged: 0,
					removed: 0,
					extractedPropositions: 12,
					elapsedMs: 800,
				},
				startedAt: "2026-10-27T02:05:00.000Z",
			};

			const completedJob: IndexingJob = {
				id: "job_completed_already",
				projectId: "proj_crash",
				sourceId: "src_3",
				state: "completed",
				progress: {
					current: 3,
					total: 3,
					currentStage: "completed",
				},
				stats: {
					added: 3,
					modified: 0,
					unchanged: 0,
					removed: 0,
					extractedPropositions: 6,
					elapsedMs: 300,
				},
				startedAt: "2026-10-27T01:50:00.000Z",
				completedAt: "2026-10-27T01:50:01.000Z",
			};

			fs.writeFileSync(path.join(idxDir, `${orphanJob1.id}.json`), JSON.stringify(orphanJob1));
			fs.writeFileSync(path.join(idxDir, `${orphanJob2.id}.json`), JSON.stringify(orphanJob2));
			fs.writeFileSync(path.join(idxDir, `${completedJob.id}.json`), JSON.stringify(completedJob));

			// Run recovery
			const recoveredCount = await queue.recoverOrphanedJobs(tmpDir);
			assert.equal(recoveredCount, 2);

			// Verify disk states
			const job1 = await queue.getIndexingJob("proj_crash", "job_orphan_1", tmpDir);
			assert.ok(job1);
			assert.equal(job1.state, "failed");
			assert.equal(job1.error, "Job interrupted by server restart");
			assert.ok(job1.completedAt);

			const job2 = await queue.getIndexingJob("proj_crash", "job_orphan_2", tmpDir);
			assert.ok(job2);
			assert.equal(job2.state, "failed");
			assert.equal(job2.error, "Job interrupted by server restart");

			const job3 = await queue.getIndexingJob("proj_crash", "job_completed_already", tmpDir);
			assert.ok(job3);
			assert.equal(job3.state, "completed"); // Untouched

			// Subtest: Automatic boot recovery via getIndexingQueue(tmpDir)
			const orphanJob3: IndexingJob = {
				id: "job_orphan_boot",
				projectId: "proj_crash",
				sourceId: "src_boot",
				state: "scanning",
				progress: {
					current: 0,
					total: 0,
					currentStage: "scanning",
				},
				stats: {
					added: 0,
					modified: 0,
					unchanged: 0,
					removed: 0,
					extractedPropositions: 0,
					elapsedMs: 50,
				},
				startedAt: "2026-10-27T03:00:00.000Z",
			};
			fs.writeFileSync(path.join(idxDir, `${orphanJob3.id}.json`), JSON.stringify(orphanJob3));

			setIndexingQueue(null);
			const bootQueue = getIndexingQueue(tmpDir);
			await bootQueue.recoveryPromise;

			const recoveredBootJob = await bootQueue.getIndexingJob("proj_crash", "job_orphan_boot", tmpDir);
			assert.ok(recoveredBootJob);
			assert.equal(recoveredBootJob.state, "failed");
			assert.equal(recoveredBootJob.error, "Job interrupted by server restart");
		} finally {
			teardown();
		}
	});

	await t.test("Suite 7: Next.js 16 Route Handlers", async () => {
		setup();
		try {
			const pStore = createProjectStore(tmpDir);
			await pStore.createProject({ id: "proj_routes", name: "Routes Project" });

			const vRegistry = createVaultRegistry(tmpDir);
			const vault = await vRegistry.registerVault({
				id: "vault_routes",
				displayName: "Vault Routes",
				kind: "obsidian",
				bindings: [{ deviceId: "local", rootPath: vaultFolder, status: "available" }],
			});

			const context = await (await import("../src/server/projects.ts")).resolveProjectContext("proj_routes", { dataDir: tmpDir });
			const src = await context.sources.addSource({
				projectId: "proj_routes",
				vaultId: vault.id,
				include: ["**/*.md"],
				exclude: [],
				recursive: true,
				enabled: true,
				syncMode: "manual",
				deletionPolicy: "deactivate",
			});

			fs.writeFileSync(path.join(vaultFolder, "test.md"), "# Test Route Note\nBody");

			const queue = new IndexingQueue(3);
			setIndexingQueue(queue);

			// 1. POST valid -> 202 Accepted
			const postReq = new Request("http://localhost/api/projects/proj_routes/sources/" + src.id + "/index", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ forceRescan: true }),
			});
			const postRes = await postSourceIndexRoute(postReq, {
				params: Promise.resolve({ id: "proj_routes", sourceId: src.id }),
			});
			assert.equal(postRes.status, 202);
			const postData = await postRes.json();
			assert.ok(postData.job);
			assert.equal(postData.job.projectId, "proj_routes");
			assert.equal(postData.job.sourceId, src.id);

			// 2. POST duplicate while running -> 409 Conflict
			const dupRes = await postSourceIndexRoute(postReq, {
				params: Promise.resolve({ id: "proj_routes", sourceId: src.id }),
			});
			assert.equal(dupRes.status, 409);
			const dupData = await dupRes.json();
			assert.equal(dupData.code, "INDEXING_CONFLICT");

			// 3. POST invalid ID -> 400
			const badIdRes = await postSourceIndexRoute(postReq, {
				params: Promise.resolve({ id: "invalid!!proj", sourceId: src.id }),
			});
			assert.equal(badIdRes.status, 400);

			// 4. POST non-existent project -> 404
			const missingProjRes = await postSourceIndexRoute(postReq, {
				params: Promise.resolve({ id: "proj_missing", sourceId: src.id }),
			});
			assert.equal(missingProjRes.status, 404);

			// 5. GET source status -> 200
			const getReq = new Request("http://localhost/api/projects/proj_routes/sources/" + src.id + "/index");
			const getRes = await getSourceIndexRoute(getReq, {
				params: Promise.resolve({ id: "proj_routes", sourceId: src.id }),
			});
			assert.equal(getRes.status, 200);
			const getData = await getRes.json();
			assert.ok("activeJob" in getData);
			assert.ok("recentJobs" in getData);

			// 6. DELETE source active job -> 200
			const delReq = new Request("http://localhost/api/projects/proj_routes/sources/" + src.id + "/index", {
				method: "DELETE",
			});
			const delRes = await deleteSourceIndexRoute(delReq, {
				params: Promise.resolve({ id: "proj_routes", sourceId: src.id }),
			});
			assert.equal(delRes.status, 200);
			const delData = await delRes.json();
			assert.equal(delData.job.state, "canceled");

			// 7. DELETE when no active job -> 404
			const delRes2 = await deleteSourceIndexRoute(delReq, {
				params: Promise.resolve({ id: "proj_routes", sourceId: src.id }),
			});
			assert.equal(delRes2.status, 404);

			// 8. GET project-level status -> 200
			const projStatusReq = new Request("http://localhost/api/projects/proj_routes/index/status");
			const projStatusRes = await getProjectIndexStatusRoute(projStatusReq, {
				params: Promise.resolve({ id: "proj_routes" }),
			});
			assert.equal(projStatusRes.status, 200);
			const projStatusData = await projStatusRes.json();
			assert.ok(Array.isArray(projStatusData.activeJobs));
			assert.ok(Array.isArray(projStatusData.queuedJobs));
			assert.ok(projStatusData.concurrency);
			assert.equal(projStatusData.concurrency.maxConcurrency, 3);
		} finally {
			teardown();
		}
	});
});
