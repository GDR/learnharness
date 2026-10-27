/**
 * Generation Counter & Commit Log Protocol Domain Contracts.
 *
 * Implements monotonic generation tracking, commit journaling, invariant checks,
 * and crash recovery state for Milestone C Slice 6.
 */

import { z } from "zod";
import type { ProjectId, SourceId, DocumentId } from "./project.ts";
import { projectIdSchema } from "./project.ts";
import type { GraphNode, GraphChain } from "./graph.ts";
import type { SourceEvidence } from "./evidence.ts";

/**
 * Checksum, line count, and byte offset metadata for a single ledger file at a specific generation.
 */
export interface LedgerSnapshot {
	byteOffset: number;
	lineCount: number;
	sha256: string;
}

export const ledgerSnapshotSchema = z.object({
	byteOffset: z.number().int().min(0),
	lineCount: z.number().int().min(0),
	sha256: z.string().length(64),
});

/**
 * Authoritative record persisted in data/projects/<projectId>/graph/generation.json.
 */
export interface ProjectGenerationRecord {
	projectId: ProjectId;
	generation: number;
	committedAt: string;
	commitId: string;
	sourceId?: SourceId;
	documentId?: DocumentId;
	jobId?: string;
	status: "committed";
	snapshots: {
		nodes: LedgerSnapshot;
		evidence: LedgerSnapshot;
		chains?: LedgerSnapshot;
		sessions?: LedgerSnapshot;
		coverage?: LedgerSnapshot;
	};
	checksums: {
		nodesSha256: string;
		evidenceSha256: string;
	};
	counts: {
		nodeCount: number;
		evidenceCount: number;
	};
}

export const projectGenerationRecordSchema = z.object({
	projectId: projectIdSchema,
	generation: z.number().int().min(0),
	committedAt: z.string().datetime(),
	commitId: z.string().min(1),
	sourceId: z.string().optional(),
	documentId: z.string().optional(),
	jobId: z.string().optional(),
	status: z.literal("committed"),
	snapshots: z.object({
		nodes: ledgerSnapshotSchema,
		evidence: ledgerSnapshotSchema,
		chains: ledgerSnapshotSchema.optional(),
		sessions: ledgerSnapshotSchema.optional(),
		coverage: ledgerSnapshotSchema.optional(),
	}),
	checksums: z
		.object({
			nodesSha256: z.string().length(64),
			evidenceSha256: z.string().length(64),
		})
		.optional()
		.default({
			nodesSha256: "",
			evidenceSha256: "",
		}),
	counts: z
		.object({
			nodeCount: z.number().int().min(0),
			evidenceCount: z.number().int().min(0),
		})
		.optional()
		.default({
			nodeCount: 0,
			evidenceCount: 0,
		}),
});

/**
 * In-flight commit journal persisted in data/projects/<projectId>/graph/.staging/journal.json
 * during the staging and swap phases.
 */
export interface CommitJournalRecord {
	projectId: ProjectId;
	targetGeneration: number;
	previousGeneration: number;
	stagedGeneration?: number;
	commitId: string;
	stage: "staging" | "validated" | "swapping" | "committed" | "rolled_back";
	status: "staged" | "committed" | "rolled_back";
	startedAt: string;
	timestamp?: string;
	stagingDir: string;
	backupDir: string;
	stagedFiles: Record<string, string>;
}

export const commitJournalRecordSchema = z.object({
	projectId: projectIdSchema,
	targetGeneration: z.number().int().min(1),
	previousGeneration: z.number().int().min(0),
	stagedGeneration: z.number().int().min(1).optional(),
	commitId: z.string().min(1),
	stage: z.enum(["staging", "validated", "swapping", "committed", "rolled_back"]),
	status: z.enum(["staged", "committed", "rolled_back"]),
	startedAt: z.string().datetime(),
	timestamp: z.string().datetime().optional(),
	stagingDir: z.string().min(1),
	backupDir: z.string().min(1),
	stagedFiles: z.record(z.string(), z.string()),
});

/**
 * Parameters submitted to GraphStore.commitGeneration.
 */
export interface CommitGenerationParams {
	projectId: ProjectId;
	nodesToAppend?: GraphNode[];
	evidenceBatch?: SourceEvidence[];
	chainsToAppend?: GraphChain[];
	sourceId?: SourceId;
	documentId?: DocumentId;
	jobId?: string;
	description?: string;
	/**
	 * Expected base generation before this commit is applied.
	 * If provided and current generation !== baseGeneration, throws GenerationConflictError (Scenario E).
	 */
	baseGeneration?: number;
}

export const commitGenerationParamsSchema = z.object({
	projectId: projectIdSchema,
	nodesToAppend: z.array(z.any()).optional().default([]),
	evidenceBatch: z.array(z.any()).optional().default([]),
	chainsToAppend: z.array(z.any()).optional().default([]),
	sourceId: z.string().optional(),
	documentId: z.string().optional(),
	jobId: z.string().optional(),
	description: z.string().optional(),
	baseGeneration: z.number().int().min(0).optional(),
});

/**
 * Result returned by a successful GraphStore.commitGeneration.
 */
export interface CommitGenerationResult {
	projectId: ProjectId;
	generation: number;
	previousGeneration: number;
	commitId: string;
	committedAt: string;
	stats: {
		nodesAppended: number;
		evidenceAppended: number;
		chainsAppended: number;
		durationMs: number;
	};
	snapshots: ProjectGenerationRecord["snapshots"];
	checksums: {
		nodesSha256: string;
		evidenceSha256: string;
	};
	counts: {
		nodeCount: number;
		evidenceCount: number;
	};
}

/**
 * Report returned by recovery actions.
 */
export interface RecoveryReport {
	action: "verified" | "rolled_back" | "repaired" | "initialized";
	generation: number;
	details?: Record<string, unknown>;
}

/**
 * Thrown when pre-commit invariant validation fails (e.g. orphan evidence, corrupt schema).
 */
export class CommitInvariantError extends Error {
	readonly status = 422;
	constructor(
		message: string,
		public readonly details?: Record<string, unknown>,
	) {
		super(`Commit invariant violated: ${message}`);
		this.name = "CommitInvariantError";
	}
}

/**
 * Thrown when baseGeneration does not match currentGeneration (Optimistic Concurrency Conflict).
 */
export class GenerationConflictError extends Error {
	readonly status = 409;
	constructor(
		public readonly expectedGeneration: number,
		public readonly currentGeneration: number,
		public readonly projectId: string,
	) {
		super(
			`Generation conflict on project "${projectId}": expected generation ${expectedGeneration}, but current generation is ${currentGeneration}`,
		);
		this.name = "GenerationConflictError";
	}
}
