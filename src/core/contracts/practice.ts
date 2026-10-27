/**
 * Scoped Practice Sets & Document Revision Warning Domain Contracts.
 *
 * Defines contracts, schemas, and validators for:
 * 1. Scoped practice set creation with immutable graph snapshots.
 * 2. Practice problem items bound to propositions and exact citations.
 * 3. Document revision snapshots and status warning indicators:
 *    ("current" | "modified" | "moved" | "deleted" | "unavailable").
 */

import { z } from "zod";
import type { ProjectId, DocumentId, VaultId } from "./project.ts";
import { projectIdSchema, vaultIdSchema } from "./project.ts";
import { type StudyScope, studyScopeSchema } from "./scope.ts";
import type { GraphChain } from "./graph.ts";
import { type SourceCitation, sourceCitationSchema } from "./retrieval.ts";
import { type GraphSnapshotSummary, graphSnapshotSummarySchema } from "./study.ts";

// ─── 1. Document Warning Status & Revision Snapshot ──────────────────────────

export type DocumentWarningStatus = "current" | "modified" | "moved" | "deleted" | "unavailable";
export const documentWarningStatuses: readonly DocumentWarningStatus[] = [
	"current",
	"modified",
	"moved",
	"deleted",
	"unavailable",
] as const;

export const documentWarningStatusSchema = z.enum([
	"current",
	"modified",
	"moved",
	"deleted",
	"unavailable",
]);

/**
 * Snapshot of a source document revision at the time a practice problem or set is generated.
 */
export interface DocumentRevisionSnapshot {
	documentId: DocumentId;
	vaultId: VaultId;
	vaultName?: string;
	path: string;
	contentHash: string;
	revisionId?: string;
	capturedAt: string;
}

export const documentRevisionSnapshotSchema = z.object({
	documentId: z.string().min(1, "documentId cannot be empty"),
	vaultId: vaultIdSchema,
	vaultName: z.string().optional(),
	path: z.string().min(1, "path cannot be empty"),
	contentHash: z.string().min(1, "contentHash cannot be empty"),
	revisionId: z.string().optional(),
	capturedAt: z.string(),
});

/**
 * Detailed warning information for a source document that has changed since problem generation.
 */
export interface DocumentRevisionWarning {
	documentId: DocumentId;
	vaultId: VaultId;
	vaultName?: string;
	originalPath: string;
	currentPath?: string;
	originalHash: string;
	currentHash?: string;
	originalRevisionId?: string;
	currentRevisionId?: string;
	status: DocumentWarningStatus;
	message: string;
	deepLink?: string;
}

export const documentRevisionWarningSchema = z.object({
	documentId: z.string().min(1),
	vaultId: vaultIdSchema,
	vaultName: z.string().optional(),
	originalPath: z.string().min(1),
	currentPath: z.string().optional(),
	originalHash: z.string().min(1),
	currentHash: z.string().optional(),
	originalRevisionId: z.string().optional(),
	currentRevisionId: z.string().optional(),
	status: documentWarningStatusSchema,
	message: z.string(),
	deepLink: z.string().optional(),
});

// ─── 2. Practice Problem Item & Scoped Practice Set ─────────────────────────

export type PracticeProblemMode = "recall" | "discrimination" | "composition";
export const practiceProblemModes: readonly PracticeProblemMode[] = [
	"recall",
	"discrimination",
	"composition",
] as const;
export const practiceProblemModeSchema = z.enum(["recall", "discrimination", "composition"]);

export interface PracticeProblemItem {
	id: string;
	statement: string;
	mode: PracticeProblemMode;
	targetPropositionIds: string[];
	modelSolution: string;
	citations: SourceCitation[];
	sourceSnapshots?: Record<DocumentId, DocumentRevisionSnapshot>;
	warningStatus?: DocumentWarningStatus;
	warningMessage?: string;
	createdAt: string;
}

export const practiceProblemItemSchema = z.object({
	id: z.string().min(1),
	statement: z.string().min(1),
	mode: practiceProblemModeSchema,
	targetPropositionIds: z.array(z.string()),
	modelSolution: z.string().min(1),
	citations: z.array(sourceCitationSchema).default([]),
	sourceSnapshots: z.record(z.string(), documentRevisionSnapshotSchema).optional(),
	warningStatus: documentWarningStatusSchema.optional(),
	warningMessage: z.string().optional(),
	createdAt: z.string(),
});

export interface ScopedProblemSet {
	id: string;
	projectId: ProjectId;
	title: string;
	createdAt: string;
	updatedAt: string;
	nodeIds: string[];
	propositions: Record<string, { name: string; statement: string }>;
	chains: GraphChain[];
	status: "active" | "completed" | "archived";
	scope: StudyScope;
	snapshot: GraphSnapshotSummary;
	problems: PracticeProblemItem[];
	citations?: SourceCitation[];
	sourceSnapshots?: Record<DocumentId, DocumentRevisionSnapshot>;
	warningSummary?: {
		hasWarnings: boolean;
		warningCount: number;
		byDocumentId: Record<DocumentId, DocumentWarningStatus>;
	};
}

export const scopedProblemSetSchema = z.object({
	id: z.string().min(1),
	projectId: projectIdSchema,
	title: z.string().min(1),
	createdAt: z.string(),
	updatedAt: z.string(),
	nodeIds: z.array(z.string()),
	propositions: z.record(z.string(), z.object({ name: z.string(), statement: z.string() })),
	chains: z.array(z.any()),
	status: z.enum(["active", "completed", "archived"]),
	scope: studyScopeSchema,
	snapshot: graphSnapshotSummarySchema,
	problems: z.array(practiceProblemItemSchema),
	citations: z.array(sourceCitationSchema).optional(),
	sourceSnapshots: z.record(z.string(), documentRevisionSnapshotSchema).optional(),
	warningSummary: z
		.object({
			hasWarnings: z.boolean(),
			warningCount: z.number().int().nonnegative(),
			byDocumentId: z.record(z.string(), documentWarningStatusSchema),
		})
		.optional(),
});

// ─── 3. Request & Response Payloads ──────────────────────────────────────────

export interface CreateScopedPracticeSetRequest {
	title?: string;
	scope?: StudyScope;
	nodeIds?: string[];
	problemCount?: number;
	modes?: PracticeProblemMode[];
	customInstructions?: string;
}

export const createScopedPracticeSetRequestSchema = z.object({
	title: z.string().trim().optional(),
	scope: studyScopeSchema.optional(),
	nodeIds: z.array(z.string()).optional(),
	problemCount: z.number().int().min(1).max(20).default(3),
	modes: z.array(practiceProblemModeSchema).optional(),
	customInstructions: z.string().trim().optional(),
});

export interface CreateScopedPracticeSetResponse {
	problemSet: ScopedProblemSet;
	snapshot: GraphSnapshotSummary;
	warnings?: DocumentRevisionWarning[];
}

export const createScopedPracticeSetResponseSchema = z.object({
	problemSet: scopedProblemSetSchema,
	snapshot: graphSnapshotSummarySchema,
	warnings: z.array(documentRevisionWarningSchema).optional(),
});

export interface ProblemSetWarningReport {
	problemSetId: string;
	projectId: ProjectId;
	hasWarnings: boolean;
	warningCount: number;
	warnings: DocumentRevisionWarning[];
	evaluatedAt: string;
}

export const problemSetWarningReportSchema = z.object({
	problemSetId: z.string(),
	projectId: projectIdSchema,
	hasWarnings: z.boolean(),
	warningCount: z.number().int().nonnegative(),
	warnings: z.array(documentRevisionWarningSchema),
	evaluatedAt: z.string(),
});

// ─── 4. Domain Errors ────────────────────────────────────────────────────────

export class InvalidPracticeRequestError extends Error {
	readonly status = 400;
	constructor(message = "Invalid practice set request") {
		super(message);
		this.name = "InvalidPracticeRequestError";
	}
}

export class ProblemSetNotFoundError extends Error {
	readonly status = 404;
	readonly problemSetId: string;
	constructor(problemSetId: string) {
		super(`Problem set not found: ${problemSetId}`);
		this.name = "ProblemSetNotFoundError";
		this.problemSetId = problemSetId;
	}
}

// ─── 5. Validators ───────────────────────────────────────────────────────────

export function validateCreateScopedPracticeSetRequest(raw: unknown): CreateScopedPracticeSetRequest {
	if (!raw || typeof raw !== "object") {
		throw new InvalidPracticeRequestError("Request payload must be a non-null object");
	}
	const res = createScopedPracticeSetRequestSchema.safeParse(raw);
	if (!res.success) {
		throw new InvalidPracticeRequestError(res.error.issues[0]?.message ?? "Invalid practice set request");
	}
	return res.data;
}

export function validateScopedProblemSet(raw: unknown): ScopedProblemSet {
	return scopedProblemSetSchema.parse(raw);
}

export function validateProblemSetWarningReport(raw: unknown): ProblemSetWarningReport {
	return problemSetWarningReportSchema.parse(raw);
}
