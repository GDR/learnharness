/**
 * Ask Sources Domain Contracts (Milestone D Slice 3).
 *
 * Defines request and response contracts, Zod schemas, domain errors,
 * and validators for grounded question answering against attached project
 * sources and Obsidian notes.
 */

import { z } from "zod";
import type { ProjectId, VaultId } from "./project.ts";
import { type StudyScope, studyScopeSchema } from "./scope.ts";
import {
	type SourceCitation,
	sourceCitationSchema,
	type SyntaxFilterFlags,
	syntaxFilterFlagsSchema,
	DEFAULT_TOP_K,
	MAX_TOP_K,
	DEFAULT_MIN_SCORE,
} from "./retrieval.ts";

export { DEFAULT_TOP_K, MAX_TOP_K, DEFAULT_MIN_SCORE };

/** Context payload sent by the Obsidian bridge plugin */
export interface BridgeContextPayload {
	filePath?: string;
	selection?: string;
	heading?: string;
	blockId?: string;
}

export const bridgeContextPayloadSchema = z.object({
	filePath: z.string().optional(),
	selection: z.string().optional(),
	heading: z.string().optional(),
	blockId: z.string().optional(),
});

/**
 * Request payload for POST /api/projects/:id/ask
 * Supports both native LearnHarness requests and Obsidian Bridge contextual commands.
 */
export interface AskSourcesRequest {
	/** The primary search and synthesis query */
	query: string;
	/** Optional StudyScope boundary */
	scope?: StudyScope;
	/** Maximum number of source sections to retrieve (default: 5, max: 20) */
	topK?: number;
	/** Minimum relevance score cutoff (default: 0.0) */
	minScore?: number;
	/** Whether to synthesize a natural language answer (default: true) */
	synthesize?: boolean;
	/** Structural syntax filters (code, table, LaTeX math) */
	syntaxFilters?: SyntaxFilterFlags;
	/** Bridge compatibility: optional question alias */
	question?: string;
	/** Bridge compatibility: active note context */
	context?: BridgeContextPayload;
	/** Bridge compatibility: target vault ID */
	vaultId?: VaultId;
}

export const askSourcesRequestSchema = z
	.object({
		query: z.string().optional(),
		question: z.string().optional(),
		scope: studyScopeSchema.optional(),
		topK: z
			.number()
			.int()
			.min(1, "topK must be >= 1")
			.max(MAX_TOP_K, `topK cannot exceed ${MAX_TOP_K}`)
			.default(DEFAULT_TOP_K),
		minScore: z.number().nonnegative("minScore must be non-negative").default(DEFAULT_MIN_SCORE),
		synthesize: z.boolean().default(true),
		syntaxFilters: syntaxFilterFlagsSchema.optional(),
		context: bridgeContextPayloadSchema.optional(),
		vaultId: z.string().optional(),
	})
	.refine(
		(data) => {
			const q = (data.query ?? data.question ?? "").trim();
			return q.length > 0;
		},
		{
			message: "Query cannot be empty (provide 'query' or 'question')",
			path: ["query"],
		},
	)
	.transform((data) => {
		const normalizedQuery = (data.query ?? data.question ?? "").trim();
		return {
			...data,
			query: normalizedQuery,
		};
	});

/**
 * Response payload for POST /api/projects/:id/ask
 */
export interface AskSourcesResponse {
	/** Synthesized answer or extractive summary */
	answer: string;
	/** Exact source citations supporting the answer */
	citations: SourceCitation[];
	/** Effective StudyScope utilized for retrieval */
	scope: StudyScope;
	/** Whether the answer was grounded in retrieved source sections */
	grounded: boolean;
	/** Observability metrics */
	retrievalStats?: {
		totalCandidates: number;
		searchDurationMs: number;
		topScore?: number;
	};
}

export const askSourcesResponseSchema = z.object({
	answer: z.string(),
	citations: z.array(sourceCitationSchema),
	scope: studyScopeSchema,
	grounded: z.boolean(),
	retrievalStats: z
		.object({
			totalCandidates: z.number().int().nonnegative(),
			searchDurationMs: z.number().nonnegative(),
			topScore: z.number().nonnegative().optional(),
		})
		.optional(),
});

/** Domain error thrown when ask query validation fails */
export class InvalidAskQueryError extends Error {
	readonly status = 400;
	constructor(message = "Invalid ask query") {
		super(message);
		this.name = "InvalidAskQueryError";
	}
}

/**
 * Validates and normalizes raw request data into AskSourcesRequest.
 * Throws InvalidAskQueryError (HTTP 400) on validation failure.
 */
export function validateAskSourcesRequest(raw: unknown): AskSourcesRequest {
	if (!raw || typeof raw !== "object") {
		throw new InvalidAskQueryError("Request body must be a non-null object");
	}
	const result = askSourcesRequestSchema.safeParse(raw);
	if (!result.success) {
		throw new InvalidAskQueryError(result.error.issues[0]?.message ?? "Invalid ask request");
	}
	return result.data as AskSourcesRequest;
}

/**
 * Validates AskSourcesResponse conforming to domain contract.
 */
export function validateAskSourcesResponse(raw: unknown): AskSourcesResponse {
	return askSourcesResponseSchema.parse(raw);
}
