/**
 * Document Inventory & Scanner Domain Contracts.
 *
 * Core domain types and Zod validation schemas for per-source document
 * inventories, content hashes, revisions, scan results, and glob filtering.
 */
import { z } from "zod";

// ─── Internal Schemas for Identifier Validation ──────────────────────────────

const projectIdRegex = /^[A-Za-z0-9_-]+$/;
const projectIdSchema = z
	.string()
	.min(1, "projectId cannot be empty")
	.regex(projectIdRegex, "projectId must contain only letters, numbers, underscores, and hyphens");

const vaultIdRegex = /^[A-Za-z0-9_-]+$/;
const vaultIdSchema = z
	.string()
	.min(1, "vaultId cannot be empty")
	.regex(vaultIdRegex, "vaultId must contain only letters, numbers, underscores, and hyphens");

const sourceIdRegex = /^[A-Za-z0-9_-]+$/;
const sourceIdSchema = z
	.string()
	.min(1, "sourceId cannot be empty")
	.regex(sourceIdRegex, "sourceId must contain only letters, numbers, underscores, and hyphens");

const documentIdSchema = z.string().min(1, "documentId cannot be empty");

const DEFAULT_SOURCE_EXCLUDE: readonly string[] = [
	".obsidian/**",
	".trash/**",
	".git/**",
	"node_modules/**",
];

const DEFAULT_SOURCE_INCLUDE: readonly string[] = ["**/*.md"];

// ─── Document Status & Schema ────────────────────────────────────────────────

export type SourceDocumentStatus = "active" | "missing" | "excluded" | "error";

export const sourceDocumentStatusSchema = z.enum(["active", "missing", "excluded", "error"]);

export interface SourceDocument {
	id: string;
	projectId?: string;
	sourceId: string;
	vaultId: string;
	currentPath: string;
	contentHash: string;
	revisionId: string;
	status: SourceDocumentStatus;
	indexedAt?: string;
	sizeBytes?: number;
	updatedAt?: string;
}

export const sourceDocumentSchema = z.object({
	id: documentIdSchema,
	projectId: projectIdSchema.optional(),
	sourceId: sourceIdSchema,
	vaultId: vaultIdSchema,
	currentPath: z.string().min(1, "currentPath cannot be empty"),
	contentHash: z.string().min(1, "contentHash cannot be empty"),
	revisionId: z.string().min(1, "revisionId cannot be empty"),
	status: sourceDocumentStatusSchema,
	indexedAt: z.string().optional(),
	sizeBytes: z.number().int().nonnegative().optional(),
	updatedAt: z.string().optional(),
});

export function validateSourceDocument(data: unknown): SourceDocument {
	return sourceDocumentSchema.parse(data);
}

// ─── Scan Result & Schema ────────────────────────────────────────────────────

export interface ScanResult {
	sourceId: string;
	vaultId: string;
	scannedCount: number;
	addedCount: number;
	modifiedCount: number;
	unchangedCount: number;
	removedCount: number;
	documents: SourceDocument[];
}

export const scanResultSchema = z.object({
	sourceId: sourceIdSchema,
	vaultId: vaultIdSchema,
	scannedCount: z.number().int().nonnegative(),
	addedCount: z.number().int().nonnegative(),
	modifiedCount: z.number().int().nonnegative(),
	unchangedCount: z.number().int().nonnegative(),
	removedCount: z.number().int().nonnegative(),
	documents: z.array(sourceDocumentSchema),
});

export function validateScanResult(data: unknown): ScanResult {
	return scanResultSchema.parse(data);
}

// ─── Pure Glob Matching & Regex Utilities ────────────────────────────────────

/**
 * Converts a standard file glob pattern into an equivalent RegExp.
 * Supports `*` (segment match), `**` (recursive path match), and `?`.
 */
export function globToRegex(pattern: string): RegExp {
	const normalized = pattern.replace(/\\/g, "/").trim();
	let regexStr = "^";
	let i = 0;
	const len = normalized.length;

	while (i < len) {
		const c = normalized[i];
		if (!c) {
			i++;
			continue;
		}
		if (c === "*") {
			if (normalized[i + 1] === "*") {
				if (normalized[i + 2] === "/") {
					regexStr += "(?:.*/)?";
					i += 3;
					continue;
				} else {
					regexStr += ".*";
					i += 2;
					continue;
				}
			} else {
				regexStr += "[^/]*";
				i++;
				continue;
			}
		} else if (c === "?") {
			regexStr += "[^/]";
			i++;
		} else if ("[].+^${}()|\\".includes(c)) {
			regexStr += "\\" + c;
			i++;
		} else {
			regexStr += c;
			i++;
		}
	}
	regexStr += "$";
	return new RegExp(regexStr);
}

/**
 * Checks whether a normalized relative file path matches the given include and exclude globs.
 * Exclude rules take precedence over include rules.
 */
export function matchesGlob(
	filePath: string,
	include: readonly string[] = DEFAULT_SOURCE_INCLUDE,
	exclude: readonly string[] = DEFAULT_SOURCE_EXCLUDE,
): boolean {
	const normalizedPath = filePath.replace(/\\/g, "/").replace(/^\.\//, "");

	// Check exclude rules first against full path and all parent path prefixes
	for (const pattern of exclude) {
		const rx = globToRegex(pattern);
		if (rx.test(normalizedPath)) {
			return false;
		}
		const parts = normalizedPath.split("/");
		let cumulative = "";
		for (let p = 0; p < parts.length - 1; p++) {
			const part = parts[p];
			if (!part) continue;
			cumulative += (p > 0 ? "/" : "") + part;
			if (rx.test(cumulative) || rx.test(cumulative + "/")) {
				return false;
			}
		}
	}

	// If include is empty, default match is false
	if (!include || include.length === 0) {
		return false;
	}

	// Check include rules
	for (const pattern of include) {
		const rx = globToRegex(pattern);
		if (rx.test(normalizedPath)) {
			return true;
		}
	}

	return false;
}

// ─── Indexing State Machine Contracts ────────────────────────────────────────

export type IndexingState =
	| "queued"
	| "scanning"
	| "extracting"
	| "validating"
	| "committing"
	| "completed"
	| "failed"
	| "canceled";

export const indexingStateSchema = z.enum([
	"queued",
	"scanning",
	"extracting",
	"validating",
	"committing",
	"completed",
	"failed",
	"canceled",
]);

export interface IndexingJobProgress {
	current: number;
	total: number;
	processedDocuments?: number;
	totalDocuments?: number;
	percent?: number;
	stage?: IndexingState;
	currentStage?: string;
	currentDocument?: string;
}

export const indexingJobProgressSchema = z.object({
	current: z.number().int().nonnegative(),
	total: z.number().int().nonnegative(),
	processedDocuments: z.number().int().nonnegative().optional(),
	totalDocuments: z.number().int().nonnegative().optional(),
	percent: z.number().nonnegative().optional(),
	stage: indexingStateSchema.optional(),
	currentStage: z.string().optional(),
	currentDocument: z.string().optional(),
});

export interface IndexingJobStats {
	added: number;
	modified: number;
	unchanged: number;
	removed: number;
	extractedPropositions: number;
	elapsedMs: number;
	scannedCount?: number;
	addedCount?: number;
	modifiedCount?: number;
	unchangedCount?: number;
	removedCount?: number;
	chunksCreated?: number;
	evidenceCreated?: number;
	durationMs?: number;
}

export const indexingJobStatsSchema = z.object({
	added: z.number().int().nonnegative(),
	modified: z.number().int().nonnegative(),
	unchanged: z.number().int().nonnegative(),
	removed: z.number().int().nonnegative(),
	extractedPropositions: z.number().int().nonnegative(),
	elapsedMs: z.number().nonnegative(),
	scannedCount: z.number().int().nonnegative().optional(),
	addedCount: z.number().int().nonnegative().optional(),
	modifiedCount: z.number().int().nonnegative().optional(),
	unchangedCount: z.number().int().nonnegative().optional(),
	removedCount: z.number().int().nonnegative().optional(),
	chunksCreated: z.number().int().nonnegative().optional(),
	evidenceCreated: z.number().int().nonnegative().optional(),
	durationMs: z.number().nonnegative().optional(),
});

export interface IndexingJob {
	id: string;
	projectId: string;
	sourceId: string;
	state: IndexingState;
	progress: IndexingJobProgress;
	stats: IndexingJobStats;
	startedAt: string;
	createdAt?: string;
	updatedAt?: string;
	completedAt?: string;
	canceledAt?: string;
	error?: string;
}

export const indexingJobSchema = z.object({
	id: z.string().min(1, "job id cannot be empty"),
	projectId: projectIdSchema,
	sourceId: sourceIdSchema,
	state: indexingStateSchema,
	progress: indexingJobProgressSchema,
	stats: indexingJobStatsSchema,
	startedAt: z.string().min(1, "startedAt cannot be empty"),
	createdAt: z.string().optional(),
	updatedAt: z.string().optional(),
	completedAt: z.string().optional(),
	canceledAt: z.string().optional(),
	error: z.string().optional(),
});

export function validateIndexingJob(data: unknown): IndexingJob {
	return indexingJobSchema.parse(data);
}

// ─── Indexing Error Classes ──────────────────────────────────────────────────

export class IndexingConflictError extends Error {
	readonly status = 409;
	readonly code = "INDEXING_CONFLICT";
	readonly projectId: string;
	readonly sourceId: string;
	readonly activeJobId?: string;

	constructor(projectId: string, sourceId: string, activeJobId?: string, message?: string) {
		super(
			message ??
				`An indexing job (${activeJobId ?? "active"}) is already in progress for source "${sourceId}" in project "${projectId}".`,
		);
		this.name = "IndexingConflictError";
		this.projectId = projectId;
		this.sourceId = sourceId;
		this.activeJobId = activeJobId;
	}
}

export class IndexingJobNotFoundError extends Error {
	readonly status = 404;
	readonly code = "JOB_NOT_FOUND";
	readonly jobId: string;

	constructor(jobId: string, message?: string) {
		super(message ?? `Indexing job not found: ${jobId}`);
		this.name = "IndexingJobNotFoundError";
		this.jobId = jobId;
	}
}

export { IndexingJobNotFoundError as IndexingNotFoundError };

// ─── API Request / Response Schemas ──────────────────────────────────────────

export interface TriggerIndexingRequest {
	forceRescan?: boolean;
}

export const triggerIndexingRequestSchema = z.object({
	forceRescan: z.boolean().optional(),
});

export interface SourceIndexingStatusResponse {
	activeJob: IndexingJob | null;
	latestJob: IndexingJob | null;
	recentJobs: IndexingJob[];
}

export const sourceIndexingStatusResponseSchema = z.object({
	activeJob: indexingJobSchema.nullable(),
	latestJob: indexingJobSchema.nullable(),
	recentJobs: z.array(indexingJobSchema),
});

export interface ProjectIndexingStatusResponse {
	activeJobs: IndexingJob[];
	queuedJobs: IndexingJob[];
	concurrency: {
		activeCount: number;
		queuedCount: number;
		maxConcurrency: number;
	};
	recentJobs: IndexingJob[];
}

export const projectIndexingStatusResponseSchema = z.object({
	activeJobs: z.array(indexingJobSchema),
	queuedJobs: z.array(indexingJobSchema),
	concurrency: z.object({
		activeCount: z.number().int().nonnegative(),
		queuedCount: z.number().int().nonnegative(),
		maxConcurrency: z.number().int().positive(),
	}),
	recentJobs: z.array(indexingJobSchema),
});
