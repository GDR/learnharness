/**
 * Durable Indexing State Machine & Queue.
 *
 * Implements bounded concurrency (max 3 concurrent jobs across server),
 * per-source mutex serialization, cancellation, persistence in
 * data/projects/<projectId>/indexing/<jobId>.json, and crash recovery.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import crypto from "node:crypto";
import { PATHS } from "../../../config.ts";
import {
	type IndexingJob,
	type ScanResult,
	IndexingConflictError,
	IndexingJobNotFoundError,
	validateIndexingJob,
} from "../../core/contracts/indexing.ts";
import { parseObsidianMarkdown } from "../../core/obsidian/parser.ts";
import { chunkObsidianDocument } from "../../core/obsidian/chunker.ts";
import { writeAtomicJson } from "../../core/fs-atomic.ts";
import {
	scanSourceDocuments,
	VaultUnavailableError,
	loadSourceInventory,
	saveSourceInventory,
} from "./scanner.ts";
import { resolveProjectSource } from "../sources.ts";
import { getProjectStore } from "../projects.ts";
import { getVaultRegistry } from "../../store/vaults.ts";
import type { ProjectStore, VaultRegistry } from "../../core/ports.ts";

export const DEFAULT_MAX_CONCURRENT_JOBS = 3;

export interface IndexingHooks {
	onValidate?: (context: {
		job: IndexingJob;
		scanResult: ScanResult;
		extractedChunks: unknown[];
		signal?: AbortSignal;
	}) => Promise<void>;
	onCommit?: (context: {
		job: IndexingJob;
		scanResult: ScanResult;
		extractedChunks: unknown[];
		signal?: AbortSignal;
	}) => Promise<void>;
}

export interface TriggerJobOptions {
	projectId: unknown;
	sourceId: unknown;
	forceRescan?: boolean;
	dataDir?: string;
	projectStore?: ProjectStore;
	vaultRegistry?: VaultRegistry;
	hooks?: IndexingHooks;
}

interface ActiveJobEntry {
	job: IndexingJob;
	abortController: AbortController;
	options: TriggerJobOptions;
	promise: Promise<void>;
}

export function getIndexingDirectory(projectId: string, dataDir?: string): string {
	const base = dataDir
		? path.resolve(dataDir)
		: (getProjectStore().dataDir ? path.resolve(getProjectStore().dataDir!) : PATHS.data);
	return path.join(base, "projects", projectId, "indexing");
}

export function getJobFilePath(projectId: string, jobId: string, dataDir?: string): string {
	return path.join(getIndexingDirectory(projectId, dataDir), `${jobId}.json`);
}

export class IndexingQueue {
	private readonly maxConcurrentJobs: number;
	private readonly activeJobs = new Map<string, ActiveJobEntry>();
	private readonly queuedJobs: Array<{ job: IndexingJob; options: TriggerJobOptions }> = [];
	private readonly sourceLocks = new Map<string, string>(); // "projectId:sourceId" -> jobId

	constructor(maxConcurrentJobs = DEFAULT_MAX_CONCURRENT_JOBS) {
		this.maxConcurrentJobs = maxConcurrentJobs;
	}

	public getMaxConcurrency(): number {
		return this.maxConcurrentJobs;
	}

	public getActiveJobsCount(): number {
		return this.activeJobs.size;
	}

	public getQueuedJobsCount(): number {
		return this.queuedJobs.length;
	}

	/**
	 * Atomically persists a job record to disk.
	 */
	public async persistJob(job: IndexingJob, dataDir?: string): Promise<void> {
		const filePath = getJobFilePath(job.projectId, job.id, dataDir);
		await writeAtomicJson(filePath, job);
	}

	public recoveryPromise: Promise<number> | null = null;

	/**
	 * Recovers any non-terminal jobs on server start, marking them as failed.
	 */
	public async recoverOrphanedJobs(dataDir?: string): Promise<number> {
		this.recoveryPromise = (async () => {
			const baseDir = dataDir
				? path.resolve(dataDir)
				: (getProjectStore().dataDir ? path.resolve(getProjectStore().dataDir!) : PATHS.data);
			const projectsDir = path.join(baseDir, "projects");
			if (!fs.existsSync(projectsDir)) return 0;

			let recoveredCount = 0;
			const projectEntries = await fs.promises.readdir(projectsDir, { withFileTypes: true });

			for (const pEntry of projectEntries) {
				if (!pEntry.isDirectory()) continue;
				const idxDir = path.join(projectsDir, pEntry.name, "indexing");
				if (!fs.existsSync(idxDir)) continue;

				const jobFiles = await fs.promises.readdir(idxDir);
				for (const f of jobFiles) {
					if (!f.endsWith(".json")) continue;
					const fPath = path.join(idxDir, f);
					try {
						const raw = await fs.promises.readFile(fPath, "utf-8");
						const parsed = JSON.parse(raw) as IndexingJob;
						if (
							parsed.state === "queued" ||
							parsed.state === "scanning" ||
							parsed.state === "extracting" ||
							parsed.state === "validating" ||
							parsed.state === "committing"
						) {
							parsed.state = "failed";
							if (parsed.progress) {
								parsed.progress.stage = "failed";
								parsed.progress.currentStage = "failed";
							}
							parsed.error = "Job interrupted by server restart";
							parsed.completedAt = new Date().toISOString();
							parsed.updatedAt = parsed.completedAt;
							await writeAtomicJson(fPath, parsed);
							recoveredCount++;
						}
					} catch {
						// ignore corrupted files
					}
				}
			}

			return recoveredCount;
		})();
		return this.recoveryPromise;
	}

	/**
	 * Triggers a new indexing job for the given project and source.
	 * Rejects with 409 Conflict if an indexing job is already active/queued for that source.
	 */
	public async triggerIndexing(options: TriggerJobOptions): Promise<IndexingJob> {
		// 1. Resolve Project & Source (validates format and existence: 400/404)
		const { validProjectId, validSourceId, source } = await resolveProjectSource(
			options.projectId,
			options.sourceId,
			{ dataDir: options.dataDir, projectStore: options.projectStore },
		);

		// 2. Validate Vault Availability (throws VaultUnavailableError 409 if unavailable)
		const vRegistry = options.vaultRegistry ?? getVaultRegistry(options.dataDir);
		const vault = await vRegistry.getVault(source.vaultId);
		if (!vault) throw new VaultUnavailableError(source.vaultId);
		const hasAvailableBinding = vault.bindings.some((b) => {
			try {
				return b.status === "available" && fs.existsSync(b.rootPath) && fs.statSync(b.rootPath).isDirectory();
			} catch {
				return false;
			}
		});
		if (!hasAvailableBinding) {
			throw new VaultUnavailableError(vault.id, `Vault "${vault.displayName}" is unavailable`);
		}

		// 3. Per-source Serialization Check
		const lockKey = `${validProjectId}:${validSourceId}`;
		const activeJobId = this.sourceLocks.get(lockKey);
		if (activeJobId) {
			throw new IndexingConflictError(validProjectId, validSourceId, activeJobId);
		}

		// 4. Create Initial Job Record
		const now = new Date().toISOString();
		const jobId = `job_idx_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
		const job: IndexingJob = {
			id: jobId,
			projectId: validProjectId,
			sourceId: validSourceId,
			state: "queued",
			progress: {
				current: 0,
				total: 0,
				processedDocuments: 0,
				totalDocuments: 0,
				percent: 0,
				stage: "queued",
				currentStage: "queued",
			},
			startedAt: now,
			createdAt: now,
			updatedAt: now,
			stats: {
				added: 0,
				modified: 0,
				unchanged: 0,
				removed: 0,
				extractedPropositions: 0,
				elapsedMs: 0,
				scannedCount: 0,
				addedCount: 0,
				modifiedCount: 0,
				unchangedCount: 0,
				removedCount: 0,
				chunksCreated: 0,
				evidenceCreated: 0,
				durationMs: 0,
			},
		};

		// 5. Acquire Source Lock & Persist Initial State
		this.sourceLocks.set(lockKey, jobId);
		await this.persistJob(job, options.dataDir);

		// 6. Enqueue & Drain
		this.queuedJobs.push({ job, options });
		void this.drainQueue();

		return job;
	}

	/**
	 * Drains queued jobs while concurrency capacity allows.
	 */
	private async drainQueue(): Promise<void> {
		while (this.activeJobs.size < this.maxConcurrentJobs && this.queuedJobs.length > 0) {
			const item = this.queuedJobs.shift();
			if (!item) break;

			// If job was canceled while queued, release lock and proceed
			if (item.job.state === "canceled") {
				this.sourceLocks.delete(`${item.job.projectId}:${item.job.sourceId}`);
				continue;
			}

			this.runActiveJob(item.job, item.options);
		}
	}

	/**
	 * Runs an individual indexing job through all stages.
	 */
	private runActiveJob(job: IndexingJob, options: TriggerJobOptions): void {
		const abortController = new AbortController();
		const lockKey = `${job.projectId}:${job.sourceId}`;

		const jobPromise = (async () => {
			const startTime = Date.now();
			try {
				// STAGE 1: Scanning
				job.state = "scanning";
				job.startedAt = new Date().toISOString();
				job.updatedAt = job.startedAt;
				job.progress.stage = "scanning";
				job.progress.currentStage = "scanning";
				await this.persistJob(job, options.dataDir);

				if (abortController.signal.aborted) throw new Error("AbortError");

				const { context } = await resolveProjectSource(job.projectId, job.sourceId, {
					dataDir: options.dataDir,
					projectStore: options.projectStore,
				});

				const scanResult = await scanSourceDocuments({
					projectId: job.projectId,
					sourceId: job.sourceId,
					forceRescan: options.forceRescan,
					dataDir: options.dataDir,
					projectStore: options.projectStore,
					vaultRegistry: options.vaultRegistry,
				});

				job.stats.added = scanResult.addedCount;
				job.stats.addedCount = scanResult.addedCount;
				job.stats.modified = scanResult.modifiedCount;
				job.stats.modifiedCount = scanResult.modifiedCount;
				job.stats.unchanged = scanResult.unchangedCount;
				job.stats.unchangedCount = scanResult.unchangedCount;
				job.stats.removed = scanResult.removedCount;
				job.stats.removedCount = scanResult.removedCount;
				job.stats.scannedCount = scanResult.scannedCount;

				// STAGE 2: Extracting Changed Notes
				const changedDocs = scanResult.documents.filter((doc) => {
					if (doc.status !== "active") return false;
					if (options.forceRescan) return true;
					if (doc.indexedAt === undefined) return true;
					if (!doc.updatedAt) return false;
					return new Date(doc.updatedAt).getTime() > new Date(doc.indexedAt).getTime();
				});

				job.state = "extracting";
				job.progress.stage = "extracting";
				job.progress.currentStage = "extracting";
				job.progress.total = changedDocs.length;
				job.progress.totalDocuments = changedDocs.length;
				job.progress.current = 0;
				job.progress.processedDocuments = 0;
				job.progress.percent = changedDocs.length > 0 ? 0 : 100;
				job.updatedAt = new Date().toISOString();
				await this.persistJob(job, options.dataDir);

				// Resolve Vault rootPath for file reading
				const vRegistry = options.vaultRegistry ?? getVaultRegistry(options.dataDir);
				const vault = await vRegistry.getVault(scanResult.vaultId);
				const binding = vault?.bindings.find((b) => b.status === "available" && fs.existsSync(b.rootPath));
				const vaultRoot = binding?.rootPath ? path.resolve(binding.rootPath) : "";

				const extractedChunks: unknown[] = [];

				for (let i = 0; i < changedDocs.length; i++) {
					if (abortController.signal.aborted) throw new Error("AbortError");

					const doc = changedDocs[i]!;
					job.progress.currentDocument = doc.currentPath;

					if (vaultRoot) {
						const fullPath = path.join(vaultRoot, doc.currentPath);
						if (fs.existsSync(fullPath)) {
							const rawContent = await fs.promises.readFile(fullPath, "utf-8");
							const parsed = parseObsidianMarkdown(rawContent);
							const chunks = chunkObsidianDocument(parsed, rawContent, {
								documentPath: doc.currentPath,
							});
							job.stats.extractedPropositions += chunks.length;
							job.stats.chunksCreated = (job.stats.chunksCreated ?? 0) + chunks.length;
							extractedChunks.push(...chunks);
						}
					}

					job.progress.current = i + 1;
					job.progress.processedDocuments = i + 1;
					job.progress.percent = Math.min(100, Math.round(((i + 1) / changedDocs.length) * 100));

					if (i % 10 === 0 || i === changedDocs.length - 1) {
						job.updatedAt = new Date().toISOString();
						await this.persistJob(job, options.dataDir);
					}
				}

				// Upon completing note extraction, update indexedAt timestamp and persist
				if (changedDocs.length > 0) {
					const indexedAtIso = new Date().toISOString();
					for (const doc of changedDocs) {
						doc.indexedAt = indexedAtIso;
					}
					if (context?.sources) {
						if (typeof context.sources.upsertDocuments === "function") {
							await context.sources.upsertDocuments(changedDocs).catch(() => {});
						} else if (typeof context.sources.upsertDocument === "function") {
							for (const doc of changedDocs) {
								await context.sources.upsertDocument(doc).catch(() => {});
							}
						}
					}
					try {
						const inv = await loadSourceInventory(job.projectId, job.sourceId, options.dataDir);
						for (const doc of changedDocs) {
							const existingDoc = inv[doc.id];
							if (existingDoc) {
								existingDoc.indexedAt = doc.indexedAt;
							} else {
								inv[doc.id] = doc;
							}
						}
						await saveSourceInventory(job.projectId, job.sourceId, inv, options.dataDir);
					} catch {
						// ignore inventory update error
					}
				}

				// STAGE 3: Validating (Hook for Slice C.5)
				if (abortController.signal.aborted) throw new Error("AbortError");
				job.state = "validating";
				job.progress.stage = "validating";
				job.progress.currentStage = "validating";
				job.updatedAt = new Date().toISOString();
				await this.persistJob(job, options.dataDir);
				if (abortController.signal.aborted) throw new Error("AbortError");
				if (options.hooks?.onValidate) {
					await options.hooks.onValidate({
						job,
						scanResult,
						extractedChunks,
						signal: abortController.signal,
					});
				}

				// STAGE 4: Committing (Hook for Slice C.6)
				if (abortController.signal.aborted) throw new Error("AbortError");
				job.state = "committing";
				job.progress.stage = "committing";
				job.progress.currentStage = "committing";
				job.updatedAt = new Date().toISOString();
				await this.persistJob(job, options.dataDir);
				if (abortController.signal.aborted) throw new Error("AbortError");
				if (options.hooks?.onCommit) {
					await options.hooks.onCommit({
						job,
						scanResult,
						extractedChunks,
						signal: abortController.signal,
					});
				}

				// STAGE 5: Completed
				job.state = "completed";
				job.progress.stage = "completed";
				job.progress.currentStage = "completed";
				job.progress.percent = 100;
				job.completedAt = new Date().toISOString();
				job.updatedAt = job.completedAt;
				job.stats.elapsedMs = Date.now() - startTime;
				job.stats.durationMs = job.stats.elapsedMs;
				await this.persistJob(job, options.dataDir);
			} catch (err: unknown) {
				const isAbort =
					abortController.signal.aborted ||
					(err instanceof Error && (err.name === "AbortError" || err.message === "AbortError"));

				const nowStr = new Date().toISOString();
				if (isAbort) {
					job.state = "canceled";
					job.progress.stage = "canceled";
					job.progress.currentStage = "canceled";
					job.completedAt = nowStr;
					job.canceledAt = nowStr;
					job.updatedAt = nowStr;
					job.stats.elapsedMs = Date.now() - startTime;
					job.stats.durationMs = job.stats.elapsedMs;
					try {
						await this.persistJob(job, options.dataDir);
					} catch (persistErr) {
						console.error(`[indexing-queue] failed to persist canceled job ${job.id}:`, persistErr);
					}
				} else {
					job.state = "failed";
					job.progress.stage = "failed";
					job.progress.currentStage = "failed";
					job.error = err instanceof Error ? err.message : String(err);
					job.completedAt = nowStr;
					job.updatedAt = nowStr;
					job.stats.elapsedMs = Date.now() - startTime;
					job.stats.durationMs = job.stats.elapsedMs;
					try {
						await this.persistJob(job, options.dataDir);
					} catch (persistErr) {
						console.error(`[indexing-queue] failed to persist failed job ${job.id}:`, persistErr);
					}
				}
			} finally {
				if (this.sourceLocks.get(lockKey) === job.id) {
					this.sourceLocks.delete(lockKey);
				}
				this.activeJobs.delete(job.id);
				void this.drainQueue();
			}
		})();

		this.activeJobs.set(job.id, {
			job,
			abortController,
			options,
			promise: jobPromise,
		});
	}

	/**
	 * Cancels a queued or active indexing job by projectId and jobId.
	 */
	public async cancelIndexingJob(projectId: string, jobId: string, dataDir?: string): Promise<IndexingJob> {
		// 1. Check queued jobs
		const qIdx = this.queuedJobs.findIndex((q) => q.job.id === jobId && q.job.projectId === projectId);
		if (qIdx !== -1) {
			const item = this.queuedJobs.splice(qIdx, 1)[0]!;
			const nowStr = new Date().toISOString();
			item.job.state = "canceled";
			item.job.progress.stage = "canceled";
			item.job.progress.currentStage = "canceled";
			item.job.completedAt = nowStr;
			item.job.canceledAt = nowStr;
			item.job.updatedAt = nowStr;
			this.sourceLocks.delete(`${item.job.projectId}:${item.job.sourceId}`);
			await this.persistJob(item.job, dataDir);
			return item.job;
		}

		// 2. Check active jobs
		const active = this.activeJobs.get(jobId);
		if (active && active.job.projectId === projectId) {
			active.abortController.abort();
			await active.promise.catch(() => {});
			return active.job;
		}

		// 3. Check persisted job on disk
		const stored = await this.getIndexingJob(projectId, jobId, dataDir);
		if (!stored) throw new IndexingJobNotFoundError(jobId);
		return stored;
	}

	/**
	 * Cancels a job with optional reason.
	 */
	public async cancelJob(jobId: string, reason?: string, projectId?: string, dataDir?: string): Promise<IndexingJob> {
		let resolvedProjectId = projectId;
		if (!resolvedProjectId) {
			const active = this.activeJobs.get(jobId);
			if (active) {
				resolvedProjectId = active.job.projectId;
			} else {
				const q = this.queuedJobs.find((item) => item.job.id === jobId);
				if (q) {
					resolvedProjectId = q.job.projectId;
				}
			}
		}

		if (resolvedProjectId) {
			const job = await this.cancelIndexingJob(resolvedProjectId, jobId, dataDir);
			if (reason && !job.error) {
				job.error = reason;
				try {
					await this.persistJob(job, dataDir);
				} catch {
					// ignore persistence errors
				}
			}
			return job;
		}

		throw new IndexingJobNotFoundError(jobId);
	}

	/**
	 * Retrieves an indexing job by ID.
	 */
	public async getIndexingJob(projectId: string, jobId: string, dataDir?: string): Promise<IndexingJob | null> {
		const active = this.activeJobs.get(jobId);
		if (active && active.job.projectId === projectId) return active.job;

		const q = this.queuedJobs.find((item) => item.job.id === jobId && item.job.projectId === projectId);
		if (q) return q.job;

		const fPath = getJobFilePath(projectId, jobId, dataDir);
		if (!fs.existsSync(fPath)) return null;

		try {
			const raw = await fs.promises.readFile(fPath, "utf-8");
			return validateIndexingJob(JSON.parse(raw));
		} catch {
			return null;
		}
	}

	/**
	 * Gets active or queued job for a specific source if any exists.
	 */
	public getActiveJobForSource(projectId: string, sourceId: string): IndexingJob | null {
		const lockKey = `${projectId}:${sourceId}`;
		const activeId = this.sourceLocks.get(lockKey);
		if (!activeId) return null;

		const active = this.activeJobs.get(activeId);
		if (active) return active.job;

		const q = this.queuedJobs.find((item) => item.job.id === activeId);
		if (q) return q.job;

		return null;
	}

	/**
	 * Lists indexing jobs for a project, optionally filtered by sourceId.
	 */
	public async listIndexingJobs(
		projectId: string,
		sourceId?: string,
		dataDir?: string,
	): Promise<IndexingJob[]> {
		const idxDir = getIndexingDirectory(projectId, dataDir);
		const jobs: IndexingJob[] = [];
		const seenIds = new Set<string>();

		// 1. In-memory active & queued
		for (const entry of this.activeJobs.values()) {
			if (entry.job.projectId === projectId) {
				if (!sourceId || entry.job.sourceId === sourceId) {
					jobs.push(entry.job);
					seenIds.add(entry.job.id);
				}
			}
		}
		for (const q of this.queuedJobs) {
			if (q.job.projectId === projectId) {
				if (!sourceId || q.job.sourceId === sourceId) {
					if (!seenIds.has(q.job.id)) {
						jobs.push(q.job);
						seenIds.add(q.job.id);
					}
				}
			}
		}

		// 2. Persisted historical jobs
		if (fs.existsSync(idxDir)) {
			const files = await fs.promises.readdir(idxDir);
			for (const f of files) {
				if (!f.endsWith(".json")) continue;
				const jobId = path.basename(f, ".json");
				if (seenIds.has(jobId)) continue;

				try {
					const raw = await fs.promises.readFile(path.join(idxDir, f), "utf-8");
					const parsed = validateIndexingJob(JSON.parse(raw));
					if (!sourceId || parsed.sourceId === sourceId) {
						jobs.push(parsed);
						seenIds.add(parsed.id);
					}
				} catch {
					// ignore corrupted files
				}
			}
		}

		// Sort by startedAt descending
		return jobs.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
	}
}

// Global Singleton Instance
let defaultQueue: IndexingQueue | null = null;

export function getIndexingQueue(
	dataDirOrMaxConcurrency?: string | number,
	maybeMaxConcurrency?: number,
): IndexingQueue {
	let dataDir: string | undefined;
	let maxConcurrency: number | undefined;

	if (typeof dataDirOrMaxConcurrency === "number") {
		maxConcurrency = dataDirOrMaxConcurrency;
	} else if (typeof dataDirOrMaxConcurrency === "string") {
		dataDir = dataDirOrMaxConcurrency;
		maxConcurrency = maybeMaxConcurrency;
	}

	if (!defaultQueue) {
		defaultQueue = new IndexingQueue(maxConcurrency);
		void defaultQueue.recoverOrphanedJobs(dataDir).catch((err) => {
			console.error("[indexing-queue] failed to recover orphaned jobs on boot:", err);
		});
	}
	return defaultQueue;
}

export function setIndexingQueue(queue: IndexingQueue | null): void {
	defaultQueue = queue;
}
