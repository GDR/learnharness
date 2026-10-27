/**
 * Graph Reconciliation Engine Domain Contracts & Zod Validation Schemas.
 *
 * Defines contracts for computing reconciliation plans, applying atomic mutations,
 * and reporting diagnostics across Scenarios A–D.
 */
import { z } from "zod";
import type { TextRange } from "./obsidian.ts";
import { textRangeSchema } from "./obsidian.ts";
import type { DocumentId, ProjectId, SourceId } from "./project.ts";
import type {
	EvidenceProvenance,
	SourceEvidence,
	SourceEvidenceLocation,
} from "./evidence.ts";
import {
	sourceEvidenceLocationSchema,
} from "./evidence.ts";
import type { GraphNode } from "./graph.ts";

export type ReconciliationScenario =
	| "A_UNCHANGED"
	| "B_MODIFIED"
	| "C_SHARED"
	| "D_DELETED";

export const reconciliationScenarioSchema = z.enum([
	"A_UNCHANGED",
	"B_MODIFIED",
	"C_SHARED",
	"D_DELETED",
]);

export const evidenceProvenanceSchema = z.enum(["explicit-source", "model-inferred"]);

/**
 * An extracted proposition candidate from document chunking/extraction.
 */
export interface ExtractedPropositionInput {
	statement: string;
	name?: string;
	aliases?: string[];
	chunkId?: string;
	heading?: string;
	headingHierarchy?: string[];
	range?: TextRange;
	location?: SourceEvidenceLocation;
	excerpt?: string;
	confidence?: number;
	provenance?: EvidenceProvenance;
	extractorVersion?: string;
}

export const extractedPropositionInputSchema = z.object({
	statement: z.string().min(1, "statement cannot be empty"),
	name: z.string().optional(),
	aliases: z.array(z.string()).default([]),
	chunkId: z.string().optional(),
	heading: z.string().optional(),
	headingHierarchy: z.array(z.string()).default([]),
	range: textRangeSchema.optional(),
	location: sourceEvidenceLocationSchema.default({}),
	excerpt: z.string().optional(),
	confidence: z.number().min(0).max(1).optional(),
	provenance: evidenceProvenanceSchema.default("explicit-source"),
	extractorVersion: z.string().optional(),
});

export function validateExtractedPropositionInput(data: unknown): ExtractedPropositionInput {
	return extractedPropositionInputSchema.parse(data);
}

export interface ReconciliationOptions {
	deletionPolicy?: "deactivate" | "retain";
	extractorVersion?: string;
	forceRescan?: boolean;
	matchProposition?: (
		extracted: ExtractedPropositionInput,
		existingNodes: GraphNode[],
	) => GraphNode | undefined;
}

/**
 * Pure, deterministic reconciliation plan before committing to GraphStore.
 */
export interface ReconciliationPlan {
	projectId: ProjectId;
	sourceId: SourceId;
	documentId: DocumentId;
	revisionId: string;
	scenario: ReconciliationScenario;

	evidenceToAppend: SourceEvidence[];
	evidenceToSupersede: SourceEvidence[];
	nodesToAppend: GraphNode[];

	unchangedEvidenceCount: number;
	reusedPropositionIds: string[];
	createdPropositionIds: string[];
	orphanedPropositionIds: string[];
	stillSupportedPropositionIds: string[];
	dedupSkippedCount?: number;
}

/**
 * Outcome of applying a reconciliation plan.
 */
export interface ReconciliationResult {
	projectId: ProjectId;
	sourceId: SourceId;
	documentId: DocumentId;
	revisionId: string;
	status: "applied" | "skipped" | "superseded" | "orphaned";
	scenario: ReconciliationScenario;
	stats: {
		evidenceAppended: number;
		evidenceSuperseded: number;
		propositionsCreated: number;
		propositionsReused: number;
		propositionsOrphaned: number;
		durationMs: number;
	};
	diagnostics: {
		reusedPropositionIds: string[];
		createdPropositionIds: string[];
		orphanedPropositionIds: string[];
		stillSupportedPropositionIds: string[];
		dedupSkippedCount: number;
	};
}

/**
 * Aggregated summary for a multi-document scan reconciliation.
 */
export interface SourceReconciliationSummary {
	projectId: ProjectId;
	sourceId: SourceId;
	totalDocuments: number;
	unchangedDocuments: number;
	modifiedDocuments: number;
	addedDocuments: number;
	deletedDocuments: number;
	totalEvidenceAppended: number;
	totalEvidenceSuperseded: number;
	totalPropositionsCreated: number;
	totalPropositionsReused: number;
	totalPropositionsOrphaned: number;
	documentResults: ReconciliationResult[];
	durationMs: number;
}
