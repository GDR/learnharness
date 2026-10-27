/**
 * Learning session contracts & StudyScope session binding.
 *
 * Connects conversational chat sessions (ChatRecord) and study sessions
 * with explicit StudyScope persistence, fallback resolution, and request schemas.
 */

import { z } from "zod";
import type { ChatRecord, ChatSummary, ChatKind } from "./chat.ts";
import {
	type StudyScope,
	studyScopeSchema,
} from "./scope.ts";
import type { ProjectId } from "./project.ts";

export type SessionKind = ChatKind | "study" | "ask";

export interface SessionRecord extends ChatRecord {
	/** Persisted study scope defining target boundary */
	scope?: StudyScope;
}

export interface SessionSummary extends ChatSummary {
	/** Study scope exposed in session listings */
	scope?: StudyScope;
}

export { resolveSessionScope } from "./scope.ts";


export const createStudySessionRequestSchema = z.object({
	title: z.string().optional(),
	scope: studyScopeSchema.optional(),
	kind: z.enum(["teach", "practice", "study", "ask"]).optional().default("study"),
});

export type CreateStudySessionRequest = z.infer<typeof createStudySessionRequestSchema>;

export type {
	StudySessionResponse,
	StudySessionRequest,
	StudySessionMode,
	GraphSnapshotSummary,
} from "./study.ts";

export {
	studySessionResponseSchema,
	studySessionRequestSchema,
	studySessionModeSchema,
	graphSnapshotSummarySchema,
	InvalidStudySessionError,
	validateStudySessionRequest,
	validateStudySessionResponse,
} from "./study.ts";

