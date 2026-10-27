/**
 * StudyScope domain contracts and Zod validation schemas.
 *
 * Scopes define the target boundary for learning sessions, adaptive practice sets,
 * and source-grounded question answering (Milestone D, Epic 7).
 *
 * Types:
 * - "project": Whole project knowledge graph and attached sources.
 * - "source": One or more attached sources (by SourceId).
 * - "document": One or more source notes/documents (by DocumentId).
 * - "tag": Obsidian notes matching specific tags (e.g. #calculus).
 * - "proposition": Specific knowledge graph proposition nodes.
 */

import { z } from "zod";
import type { ProjectId, SourceId, DocumentId } from "./project.ts";

export type StudyScopeType = "project" | "source" | "document" | "tag" | "proposition";
export type SourceGroundingMode = "sources-only" | "sources-plus-external";

export const studyScopeTypes: readonly StudyScopeType[] = [
	"project",
	"source",
	"document",
	"tag",
	"proposition",
] as const;

export const sourceGroundingModes: readonly SourceGroundingMode[] = [
	"sources-only",
	"sources-plus-external",
] as const;

export const studyScopeTypeSchema = z.enum(["project", "source", "document", "tag", "proposition"]);
export const sourceGroundingModeSchema = z.enum(["sources-only", "sources-plus-external"]);

// Re-declare internal schema validators matching project.ts to avoid cyclic imports
const projectIdRegex = /^[A-Za-z0-9_-]+$/;
const projectIdSchema = z
	.string()
	.min(1, "projectId cannot be empty")
	.regex(projectIdRegex, "projectId must contain only letters, numbers, underscores, and hyphens");

const sourceIdRegex = /^[A-Za-z0-9_-]+$/;
const sourceIdSchema = z
	.string()
	.min(1, "sourceId cannot be empty")
	.regex(sourceIdRegex, "sourceId must contain only letters, numbers, underscores, and hyphens");

const documentIdSchema = z.string().min(1, "documentId cannot be empty");

export interface BaseStudyScope {
	type?: StudyScopeType;
	projectId?: ProjectId;
	includePrerequisites?: boolean;
	grounding?: SourceGroundingMode;
}

export interface ProjectStudyScope extends BaseStudyScope {
	type: "project";
}

export interface SourceStudyScope extends BaseStudyScope {
	type: "source";
	sourceIds: SourceId[];
}

export interface DocumentStudyScope extends BaseStudyScope {
	type: "document";
	documentIds: DocumentId[];
}

export interface TagStudyScope extends BaseStudyScope {
	type: "tag";
	tagNames?: string[];
	tags?: string[];
}

export interface PropositionStudyScope extends BaseStudyScope {
	type: "proposition";
	propositionIds: string[];
}

export type DiscriminatedStudyScope =
	| ProjectStudyScope
	| SourceStudyScope
	| DocumentStudyScope
	| TagStudyScope
	| PropositionStudyScope;

export interface StudyScope {
	projectId?: ProjectId;
	type?: StudyScopeType;
	sourceIds?: SourceId[];
	documentIds?: DocumentId[];
	tagNames?: string[];
	tags?: string[];
	propositionIds?: string[];
	includePrerequisites?: boolean;
	grounding?: SourceGroundingMode;
}

export class InvalidStudyScopeError extends Error {
	readonly status = 400;
	constructor(message = "Invalid study scope") {
		super(message);
		this.name = "InvalidStudyScopeError";
	}
}

/**
 * Pure helper to infer StudyScopeType from populated target arrays if type is omitted.
 */
export function inferStudyScopeType(scope: {
	type?: StudyScopeType;
	sourceIds?: unknown[];
	documentIds?: unknown[];
	tagNames?: unknown[];
	tags?: unknown[];
	propositionIds?: unknown[];
}): StudyScopeType {
	if (scope.type) return scope.type;
	if (Array.isArray(scope.sourceIds) && scope.sourceIds.length > 0) return "source";
	if (Array.isArray(scope.documentIds) && scope.documentIds.length > 0) return "document";
	if (
		(Array.isArray(scope.tagNames) && scope.tagNames.length > 0) ||
		(Array.isArray(scope.tags) && scope.tags.length > 0)
	) {
		return "tag";
	}
	if (Array.isArray(scope.propositionIds) && scope.propositionIds.length > 0) return "proposition";
	return "project";
}

/**
 * Preprocessing Zod schema:
 * 1. Automatically harmonizes tagNames and tags.
 * 2. Infers `type` if omitted based on present target collections.
 * 3. Applies defaults for includePrerequisites (false) and grounding ("sources-only").
 * 4. Enforces that target collections match their scope type.
 * 5. Preserves 100% backward compatibility with existing tests.
 */
export const studyScopeSchema = z.preprocess((val) => {
	if (!val || typeof val !== "object") return val;
	const obj = { ...(val as Record<string, unknown>) };

	// Harmonize tagNames and tags
	if (Array.isArray(obj.tagNames) && !obj.tags) {
		obj.tags = [...obj.tagNames];
	} else if (Array.isArray(obj.tags) && !obj.tagNames) {
		obj.tagNames = [...obj.tags];
	}

	// Infer type if absent
	if (!obj.type) {
		if (Array.isArray(obj.sourceIds) && obj.sourceIds.length > 0) {
			obj.type = "source";
		} else if (Array.isArray(obj.documentIds) && obj.documentIds.length > 0) {
			obj.type = "document";
		} else if (Array.isArray(obj.tags) && obj.tags.length > 0) {
			obj.type = "tag";
		} else if (Array.isArray(obj.propositionIds) && obj.propositionIds.length > 0) {
			obj.type = "proposition";
		} else {
			obj.type = "project";
		}
	}

	if (obj.includePrerequisites === undefined) {
		obj.includePrerequisites = false;
	}
	if (obj.grounding === undefined) {
		obj.grounding = "sources-only";
	}

	return obj;
}, z.object({
	type: studyScopeTypeSchema.default("project"),
	projectId: projectIdSchema.optional(),
	sourceIds: z.array(sourceIdSchema).optional(),
	documentIds: z.array(documentIdSchema).optional(),
	tagNames: z.array(z.string().min(1, "tag cannot be empty")).optional(),
	tags: z.array(z.string().min(1, "tag cannot be empty")).optional(),
	propositionIds: z.array(z.string().min(1, "propositionId cannot be empty")).optional(),
	includePrerequisites: z.boolean().default(false),
	grounding: sourceGroundingModeSchema.default("sources-only"),
}).superRefine((data, ctx) => {
	if (data.type === "source" && (!data.sourceIds || data.sourceIds.length === 0)) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Scope type 'source' requires at least one sourceId in sourceIds",
			path: ["sourceIds"],
		});
	}
	if (data.type === "document" && (!data.documentIds || data.documentIds.length === 0)) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Scope type 'document' requires at least one documentId in documentIds",
			path: ["documentIds"],
		});
	}
	if (
		data.type === "tag" &&
		(!data.tagNames || data.tagNames.length === 0) &&
		(!data.tags || data.tags.length === 0)
	) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Scope type 'tag' requires at least one tag in tagNames or tags",
			path: ["tagNames"],
		});
	}
	if (data.type === "proposition" && (!data.propositionIds || data.propositionIds.length === 0)) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: "Scope type 'proposition' requires at least one propositionId in propositionIds",
			path: ["propositionIds"],
		});
	}
}));

export function validateStudyScope(raw: unknown): StudyScope {
	if (!raw || typeof raw !== "object") {
		throw new InvalidStudyScopeError("StudyScope must be a non-null object");
	}
	const result = studyScopeSchema.safeParse(raw);
	if (!result.success) {
		throw new InvalidStudyScopeError(
			result.error.issues[0]?.message ?? `Invalid study scope format: ${JSON.stringify(raw)}`,
		);
	}
	return result.data as StudyScope;
}

export const DEFAULT_STUDY_SCOPE: StudyScope = {
	type: "project",
	includePrerequisites: false,
	grounding: "sources-only",
};

export function createDefaultStudyScope(projectId?: ProjectId): StudyScope {
	return {
		type: "project",
		...(projectId ? { projectId } : {}),
		includePrerequisites: false,
		grounding: "sources-only",
	};
}

/**
 * Resolves the effective study scope for a session.
 * For legacy sessions lacking an explicit scope, safely returns a project-wide scope.
 */
export function resolveSessionScope(
	session?: { scope?: StudyScope; projectId?: ProjectId } | null,
	defaultProjectId?: ProjectId,
): StudyScope {
	const fallbackProjectId = session?.projectId ?? defaultProjectId;
	if (session?.scope) {
		const s = session.scope;
		const effectiveProjectId = s.projectId ?? fallbackProjectId;
		return {
			...s,
			type: s.type ?? inferStudyScopeType(s),
			includePrerequisites: s.includePrerequisites ?? false,
			grounding: s.grounding ?? "sources-only",
			...(effectiveProjectId ? { projectId: effectiveProjectId } : {}),
		};
	}
	return createDefaultStudyScope(fallbackProjectId);
}


