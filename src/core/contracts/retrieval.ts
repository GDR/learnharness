/**
 * Source-Aware Retrieval & Ranking Domain Contracts.
 *
 * Defines contracts, schemas, and validators for lexical/structural retrieval
 * across Obsidian note sections with multi-project isolation, StudyScope boundaries,
 * and exact line/character citations.
 */

import { z } from "zod";
import type { ProjectId, SourceId, DocumentId, VaultId } from "./project.ts";
import { type StudyScope, studyScopeSchema } from "./scope.ts";
import { type TextRange, textRangeSchema } from "./obsidian.ts";

/** Default and maximum limits for retrieval */
export const DEFAULT_TOP_K = 5;
export const MAX_TOP_K = 20;
export const DEFAULT_MIN_SCORE = 0.0;

/** Syntax capability filters for retrieved chunks */
export interface SyntaxFilterFlags {
	hasCodeBlock?: boolean;
	hasTable?: boolean;
	hasEquation?: boolean;
}

export const syntaxFilterFlagsSchema = z.object({
	hasCodeBlock: z.boolean().optional(),
	hasTable: z.boolean().optional(),
	hasEquation: z.boolean().optional(),
});

/** 1-based line range within a file */
export interface LineRange {
	start: number; // 1-indexed start line
	end: number; // 1-indexed end line (inclusive)
}

export const lineRangeSchema = z
	.object({
		start: z.number().int().min(1, "start line must be >= 1"),
		end: z.number().int().min(1, "end line must be >= 1"),
	})
	.refine((data) => data.end >= data.start, {
		message: "end line must be greater than or equal to start line",
		path: ["end"],
	});

/**
 * Exact citation pointing back to the original source document and section.
 */
export interface SourceCitation {
	sourceId: SourceId;
	sourceName?: string;
	vaultId: VaultId;
	vaultName: string;
	documentId?: DocumentId;
	documentPath: string;
	sectionHeading?: string;
	headingHierarchy: string[];
	lineRange: LineRange;
	characterRange: TextRange;
	deepLink: string;
	blockId?: string;
	revisionId?: string;
	contentHash?: string;
}

export const sourceCitationSchema = z.object({
	sourceId: z.string().min(1, "sourceId cannot be empty"),
	sourceName: z.string().optional(),
	vaultId: z.string().min(1, "vaultId cannot be empty"),
	vaultName: z.string().min(1, "vaultName cannot be empty"),
	documentId: z.string().optional(),
	documentPath: z.string().min(1, "documentPath cannot be empty"),
	sectionHeading: z.string().optional(),
	headingHierarchy: z.array(z.string()),
	lineRange: lineRangeSchema,
	characterRange: textRangeSchema,
	deepLink: z.string().min(1, "deepLink cannot be empty"),
	blockId: z.string().optional(),
	revisionId: z.string().optional(),
	contentHash: z.string().optional(),
});

/**
 * A single retrieved section with relevance score and exact citation.
 */
export interface RetrievedSection {
	sectionId: string;
	content: string;
	score: number;
	matchHighlights?: string[];
	citation: SourceCitation;
	tokenEstimate?: number;
	blockIds?: string[];
	hasCodeBlock?: boolean;
	hasTable?: boolean;
	hasEquation?: boolean;
}

export const retrievedSectionSchema = z.object({
	sectionId: z.string().min(1, "sectionId cannot be empty"),
	content: z.string(),
	score: z.number().nonnegative("score must be non-negative"),
	matchHighlights: z.array(z.string()).optional(),
	citation: sourceCitationSchema,
	tokenEstimate: z.number().int().nonnegative().optional(),
	blockIds: z.array(z.string()).optional(),
	hasCodeBlock: z.boolean().optional(),
	hasTable: z.boolean().optional(),
	hasEquation: z.boolean().optional(),
});

/**
 * Input query for source-aware retrieval.
 */
export interface RetrievalQuery {
	query: string;
	scope?: StudyScope;
	topK?: number;
	minScore?: number;
	syntaxFilters?: SyntaxFilterFlags;
}

export const retrievalQuerySchema = z.object({
	query: z.string().trim().min(1, "query cannot be empty"),
	scope: studyScopeSchema.optional(),
	topK: z
		.number()
		.int()
		.min(1, "topK must be >= 1")
		.max(MAX_TOP_K, `topK cannot exceed ${MAX_TOP_K}`)
		.default(DEFAULT_TOP_K),
	minScore: z.number().nonnegative("minScore must be non-negative").default(DEFAULT_MIN_SCORE),
	syntaxFilters: syntaxFilterFlagsSchema.optional(),
});

/**
 * Complete result returned by the retrieval engine.
 */
export interface RetrievalResult {
	sections: RetrievedSection[];
	totalCandidates: number;
	searchDurationMs: number;
	query: string;
	scope: StudyScope;
}

export const retrievalResultSchema = z.object({
	sections: z.array(retrievedSectionSchema),
	totalCandidates: z.number().int().nonnegative("totalCandidates must be non-negative"),
	searchDurationMs: z.number().nonnegative("searchDurationMs must be non-negative"),
	query: z.string(),
	scope: studyScopeSchema,
});

/**
 * Ranking options and tuning parameters.
 */
export interface RankingOptions {
	k1?: number; // BM25 term frequency saturation, default: 1.2
	b?: number; // BM25 document length normalization, default: 0.75
	headingBoost?: number; // direct heading boost multiplier, default: 2.5
	ancestorHeadingBoost?: number; // ancestor hierarchy boost multiplier, default: 1.5
	pathBoost?: number; // file path & title match boost multiplier, default: 1.8
	exactPhraseBoost?: number; // exact phrase boost multiplier, default: 1.5
	propositionGroundingBoost?: number; // evidence match boost multiplier, default: 1.5
}

export const rankingOptionsSchema = z.object({
	k1: z.number().positive().default(1.2),
	b: z.number().min(0).max(1).default(0.75),
	headingBoost: z.number().positive().default(2.5),
	ancestorHeadingBoost: z.number().positive().default(1.5),
	pathBoost: z.number().positive().default(1.8),
	exactPhraseBoost: z.number().positive().default(1.5),
	propositionGroundingBoost: z.number().positive().default(1.5),
});

/** Error thrown when query validation fails */
export class InvalidRetrievalQueryError extends Error {
	readonly status = 400;
	constructor(message = "Invalid retrieval query") {
		super(message);
		this.name = "InvalidRetrievalQueryError";
	}
}

export function validateRetrievalQuery(raw: unknown): RetrievalQuery {
	if (!raw || typeof raw !== "object") {
		throw new InvalidRetrievalQueryError("Retrieval query must be a non-null object");
	}
	const result = retrievalQuerySchema.safeParse(raw);
	if (!result.success) {
		throw new InvalidRetrievalQueryError(result.error.issues[0]?.message ?? "Invalid retrieval query");
	}
	return result.data;
}

export function validateRetrievalResult(raw: unknown): RetrievalResult {
	return retrievalResultSchema.parse(raw);
}

export function validateRetrievedSection(raw: unknown): RetrievedSection {
	return retrievedSectionSchema.parse(raw);
}
