/**
 * Scoped Study Sessions Domain Contracts (Milestone D Slice 4).
 *
 * Defines request and response contracts, Zod schemas, domain errors,
 * and immutable graph snapshot types for scoped adaptive study sessions.
 */

import { z } from "zod";
import type { ProjectId } from "./project.ts";
import { projectIdSchema } from "./project.ts";
import { type StudyScope, studyScopeSchema } from "./scope.ts";

export type StudySessionMode = "probe" | "teach" | "mixed";
export const studySessionModes: readonly StudySessionMode[] = ["probe", "teach", "mixed"] as const;
export const studySessionModeSchema = z.enum(["probe", "teach", "mixed"]);

/**
 * Summary of the immutable knowledge graph snapshot captured at session creation.
 */
export interface GraphSnapshotSummary {
	/** Monotonic graph generation number at capture time */
	generation?: number;
	/** Number of proposition nodes in scope */
	nodeCount: number;
	/** Number of reasoning chains connecting scoped nodes */
	chainCount: number;
	/** Number of active SourceEvidence items supporting these propositions */
	evidenceCount?: number;
	/** Sorted proposition IDs in scope at capture time */
	nodeIds: string[];
	/** ISO 8601 timestamp of snapshot capture */
	capturedAt: string;
	/** Integrity checksum over the captured nodes and chains */
	checksum?: string;
}

export const graphSnapshotSummarySchema = z.object({
	generation: z.number().int().min(0).optional(),
	nodeCount: z.number().int().min(0),
	chainCount: z.number().int().min(0),
	evidenceCount: z.number().int().min(0).optional(),
	nodeIds: z.array(z.string()),
	capturedAt: z.string().datetime(),
	checksum: z.string().optional(),
});

/**
 * Request payload for POST /api/projects/:id/study-sessions
 */
export interface StudySessionRequest {
	/** Optional study scope; defaults to project-wide scope if omitted */
	scope?: StudyScope;
	/** Optional specific topic or note to focus on */
	topic?: string;
	/** Session mode: probe first, direct teach, or adaptive mixed (default: "mixed") */
	mode?: StudySessionMode;
	/** Optional custom instructions or focus areas */
	customInstructions?: string;
	/** Optional session title */
	title?: string;

	// Obsidian Bridge compatibility fields
	vaultName?: string;
	vaultId?: string;
	filePath?: string;
	content?: string;
	selection?: string;
	heading?: string;
	folderPath?: string;
	filePaths?: string[];
	noteCount?: number;
	scopeType?: string;
}

export const studySessionRequestSchema = z.object({
	scope: studyScopeSchema.optional(),
	topic: z.string().trim().optional(),
	mode: studySessionModeSchema.default("mixed"),
	customInstructions: z.string().trim().optional(),
	title: z.string().trim().optional(),

	// Bridge fields
	vaultName: z.string().optional(),
	vaultId: z.string().optional(),
	filePath: z.string().optional(),
	content: z.string().optional(),
	selection: z.string().optional(),
	heading: z.string().optional(),
	folderPath: z.string().optional(),
	filePaths: z.array(z.string()).optional(),
	noteCount: z.number().optional(),
	scopeType: z.string().optional(),
});

/**
 * Response payload for POST /api/projects/:id/study-sessions
 */
export interface StudySessionResponse {
	/** Unique chat session ID (e.g. chat_...) */
	sessionId: string;
	/** Project ID owning this session */
	projectId: ProjectId;
	/** Validated, authoritative StudyScope persisted on the session */
	scope: StudyScope;
	/** Generated initial prompt seeded into the study session */
	initialPrompt: string;
	/** Immutable graph snapshot captured at creation */
	snapshot: GraphSnapshotSummary;
	/** ISO timestamp when the session was created */
	createdAt: string;
	/** Title of the created session */
	title: string;
	/** Selected study mode */
	mode: StudySessionMode;
}

export const studySessionResponseSchema = z.object({
	sessionId: z.string().min(1),
	projectId: projectIdSchema,
	scope: studyScopeSchema,
	initialPrompt: z.string(),
	snapshot: graphSnapshotSummarySchema,
	createdAt: z.string().datetime(),
	title: z.string().min(1),
	mode: studySessionModeSchema,
});

export class InvalidStudySessionError extends Error {
	readonly status = 400;
	constructor(message = "Invalid study session request") {
		super(message);
		this.name = "InvalidStudySessionError";
	}
}

export function validateStudySessionRequest(raw: unknown): StudySessionRequest {
	if (!raw || typeof raw !== "object") {
		throw new InvalidStudySessionError("Request body must be a non-null object");
	}
	const result = studySessionRequestSchema.safeParse(raw);
	if (!result.success) {
		throw new InvalidStudySessionError(result.error.issues[0]?.message ?? "Invalid study session request");
	}
	return result.data as StudySessionRequest;
}

export function validateStudySessionResponse(raw: unknown): StudySessionResponse {
	return studySessionResponseSchema.parse(raw);
}
