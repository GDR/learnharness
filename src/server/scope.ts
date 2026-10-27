/**
 * Server-side StudyScope resolution and validation.
 *
 * Verifies that referenced sources and documents actually exist within the
 * active project, preventing cross-project data leakage and silent errors.
 */

import {
	type StudyScope,
	type StudyScopeType,
	type SourceGroundingMode,
	validateStudyScope,
	createDefaultStudyScope,
	InvalidStudyScopeError,
} from "../core/contracts/scope.ts";
import { type ProjectId, SourceNotFoundError } from "../core/contracts/project.ts";
import type { ProjectContext } from "../core/contracts/project.ts";

export { InvalidStudyScopeError };

export class DocumentNotFoundError extends Error {
	readonly status = 404;
	readonly documentId: string;
	constructor(documentId: string) {
		super(`Document not found: ${documentId}`);
		this.name = "DocumentNotFoundError";
		this.documentId = documentId;
	}
}

export class ScopeResolutionError extends Error {
	readonly status = 400;
	constructor(message: string) {
		super(message);
		this.name = "ScopeResolutionError";
	}
}

export interface ResolvedStudyScope {
	scope: StudyScope;
	type: StudyScopeType;
	projectId: ProjectId;
	resolvedSourceIds: string[];
	resolvedDocumentIds: string[];
	resolvedPropositionIds: string[];
	tagNames: string[];
	tags: string[];
	includePrerequisites: boolean;
	grounding: SourceGroundingMode;
}

export async function validateAndResolveStudyScope(
	rawScope: unknown,
	context: ProjectContext,
): Promise<ResolvedStudyScope> {
	if (!context || !context.projectId) {
		throw new ScopeResolutionError("A valid ProjectContext with projectId is required for scope resolution");
	}

	const scope = validateStudyScope(rawScope ?? createDefaultStudyScope(context.projectId));

	if (scope.projectId && scope.projectId !== context.projectId) {
		throw new ScopeResolutionError(
			`Scope projectId '${scope.projectId}' does not match context projectId '${context.projectId}'`,
		);
	}

	const type = scope.type ?? "project";
	const resolvedSourceIds: string[] = [];
	const resolvedDocumentIds: string[] = [];
	const resolvedPropositionIds: string[] = [...(scope.propositionIds ?? [])];
	const tagNames: string[] = [...(scope.tagNames ?? scope.tags ?? [])];
	const tags: string[] = [...(scope.tags ?? scope.tagNames ?? [])];

	const projectSources = await context.sources.listSources(context.projectId);
	const sourceMap = new Map(projectSources.map((s) => [s.id, s]));

	if (type === "source" || (scope.sourceIds && scope.sourceIds.length > 0)) {
		for (const srcId of scope.sourceIds ?? []) {
			if (!sourceMap.has(srcId)) {
				throw new SourceNotFoundError(srcId);
			}
			resolvedSourceIds.push(srcId);
		}
	}

	if (type === "document" || (scope.documentIds && scope.documentIds.length > 0)) {
		// Collect all document IDs from all sources attached to the project
		const allProjectDocIds = new Set<string>();
		for (const source of projectSources) {
			const docs = await context.sources.listDocuments(source.id);
			for (const doc of docs) {
				allProjectDocIds.add(doc.id);
			}
		}

		for (const docId of scope.documentIds ?? []) {
			if (!allProjectDocIds.has(docId)) {
				throw new DocumentNotFoundError(docId);
			}
			resolvedDocumentIds.push(docId);
		}
	}

	return {
		scope: {
			...scope,
			projectId: context.projectId,
		},
		type,
		projectId: context.projectId,
		resolvedSourceIds,
		resolvedDocumentIds,
		resolvedPropositionIds,
		tagNames,
		tags,
		includePrerequisites: scope.includePrerequisites ?? false,
		grounding: scope.grounding ?? "sources-only",
	};
}
