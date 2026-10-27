/**
 * Markdown Chunker Domain Contracts & Validation Schemas.
 *
 * Core contracts for section-aware Markdown chunking:
 * - MarkdownChunk: Structured chunk preserving heading hierarchies,
 *   token estimate, byte-exact character offsets, and syntax capability flags.
 * - ChunkerOptions: Configurable token budget limits and overlap parameters.
 */
import { z } from "zod";
import { type TextRange, textRangeSchema } from "./obsidian.ts";

export interface MarkdownChunk {
	id: string;
	documentPath: string;
	headingHierarchy: string[];
	heading?: string;
	range: TextRange;
	content: string;
	tokenEstimate: number;
	blockIds?: string[];
	hasCodeBlock?: boolean;
	hasTable?: boolean;
	hasEquation?: boolean;
}

export const markdownChunkSchema = z.object({
	id: z.string().min(1, "Chunk id cannot be empty"),
	documentPath: z.string(),
	headingHierarchy: z.array(z.string()),
	heading: z.string().optional(),
	range: textRangeSchema,
	content: z.string(),
	tokenEstimate: z.number().int().nonnegative("tokenEstimate must be non-negative"),
	blockIds: z.array(z.string()).optional(),
	hasCodeBlock: z.boolean().optional(),
	hasTable: z.boolean().optional(),
	hasEquation: z.boolean().optional(),
});

export function validateMarkdownChunk(raw: unknown): MarkdownChunk {
	return markdownChunkSchema.parse(raw);
}

export interface ChunkerOptions {
	maxTokens?: number;
	minTokens?: number;
	overlapTokens?: number;
	documentPath?: string;
}

export const chunkerOptionsSchema = z.object({
	maxTokens: z.number().int().positive("maxTokens must be positive").optional(),
	minTokens: z.number().int().nonnegative("minTokens must be non-negative").optional(),
	overlapTokens: z.number().int().nonnegative("overlapTokens must be non-negative").optional(),
	documentPath: z.string().optional(),
});

export function validateChunkerOptions(raw: unknown): ChunkerOptions {
	return chunkerOptionsSchema.parse(raw);
}
