/**
 * SourceEvidence Domain Contracts & Ledgers.
 *
 * Core domain types and Zod validation schemas for granular source evidence
 * linking propositions to specific document revisions, chunks, and character ranges.
 */
import { z } from "zod";
import type { DocumentId, ProjectId, SourceId } from "./project.ts";
import { type TextRange, textRangeSchema } from "./obsidian.ts";

export type EvidenceId = string;
export const evidenceIdSchema = z.string().min(1, "evidenceId cannot be empty");

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

export interface SourceEvidenceLocation {
	heading?: string;
	blockId?: string;
	startOffset?: number;
	endOffset?: number;
}

export const sourceEvidenceLocationSchema = z.object({
	heading: z.string().optional(),
	blockId: z.string().optional(),
	startOffset: z.number().int().nonnegative("startOffset must be a non-negative integer").optional(),
	endOffset: z.number().int().nonnegative("endOffset must be a non-negative integer").optional(),
});

export type EvidenceProvenance = "explicit-source" | "model-inferred";
export type EvidenceStatus = "active" | "superseded";

export interface SourceEvidence {
	id: EvidenceId;
	propositionId: string;
	sourceId: SourceId;
	documentId: DocumentId;
	documentPath?: string;
	chunkId?: string;
	heading?: string;
	headingHierarchy?: string[];
	range?: TextRange;
	excerpt?: string;
	recordedAt?: string;
	confidence?: number;
	revisionId?: string;
	projectId?: ProjectId;
	provenance?: EvidenceProvenance;
	status?: EvidenceStatus;
	extractorVersion?: string;
	location?: SourceEvidenceLocation;
}

export const sourceEvidenceSchema = z.object({
	id: evidenceIdSchema,
	propositionId: z.string().min(1, "propositionId cannot be empty"),
	sourceId: sourceIdSchema,
	documentId: documentIdSchema,
	documentPath: z.string().optional(),
	chunkId: z.string().optional(),
	heading: z.string().optional(),
	headingHierarchy: z.array(z.string()).default([]),
	range: textRangeSchema.optional(),
	excerpt: z.string().optional(),
	recordedAt: z.string().optional(),
	confidence: z.number().min(0).max(1).optional(),
	revisionId: z.string().optional(),
	projectId: projectIdSchema.optional(),
	provenance: z.enum(["explicit-source", "model-inferred"]).default("explicit-source"),
	status: z.enum(["active", "superseded"]).default("active"),
	extractorVersion: z.string().optional(),
	location: sourceEvidenceLocationSchema.default({}),
});

export function validateSourceEvidence(raw: unknown): SourceEvidence {
	return sourceEvidenceSchema.parse(raw);
}

export function computeEvidenceDedupKey(evidence: SourceEvidence): string {
	const start = evidence.range?.startOffset ?? evidence.location?.startOffset ?? 0;
	const end = evidence.range?.endOffset ?? evidence.location?.endOffset ?? 0;
	const chunk = evidence.chunkId ?? "";
	const rev = evidence.revisionId ?? "";
	return `${evidence.documentId}:${evidence.propositionId}:${chunk}:${start}_${end}:${rev}`;
}
