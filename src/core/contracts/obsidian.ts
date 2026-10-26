/**
 * Obsidian AST & Markdown Syntax Domain Contracts.
 *
 * Core domain types and Zod validation schemas for parsed Obsidian documents,
 * including YAML frontmatter, hierarchical headings & sections, structured blocks,
 * LaTeX equations, callouts, wiki-links, block references, and tags with exact
 * character offsets.
 */
import { z } from "zod";

// ─── Text Range & Offsets ────────────────────────────────────────────────────

export interface TextRange {
	startOffset: number;
	endOffset: number;
}

export const textRangeSchema = z.object({
	startOffset: z.number().int().nonnegative("startOffset must be non-negative"),
	endOffset: z.number().int().nonnegative("endOffset must be non-negative"),
});

// ─── Headings ────────────────────────────────────────────────────────────────

export interface ParsedHeading {
	level: number; // 1..6
	text: string;
	slug: string;
	range: TextRange;
}

export const parsedHeadingSchema = z.object({
	level: z.number().int().min(1).max(6),
	text: z.string(),
	slug: z.string(),
	range: textRangeSchema,
});

// ─── Blocks ──────────────────────────────────────────────────────────────────

export type ParsedBlockKind =
	| "paragraph"
	| "code"
	| "table"
	| "math"
	| "callout"
	| "list"
	| "heading";

export const parsedBlockKindSchema = z.enum([
	"paragraph",
	"code",
	"table",
	"math",
	"callout",
	"list",
	"heading",
]);

export interface ParsedBlock {
	id?: string;
	kind: ParsedBlockKind;
	range: TextRange;
	rawText: string;
}

export const parsedBlockSchema = z.object({
	id: z.string().optional(),
	kind: parsedBlockKindSchema,
	range: textRangeSchema,
	rawText: z.string(),
});

// ─── Sections ────────────────────────────────────────────────────────────────

export interface ParsedSection {
	id: string;
	heading?: ParsedHeading;
	headingHierarchy: string[];
	range: TextRange;
	rawText: string;
	blocks: ParsedBlock[];
}

export const parsedSectionSchema = z.object({
	id: z.string().min(1, "Section id cannot be empty"),
	heading: parsedHeadingSchema.optional(),
	headingHierarchy: z.array(z.string()),
	range: textRangeSchema,
	rawText: z.string(),
	blocks: z.array(parsedBlockSchema),
});

// ─── Wiki-Links ──────────────────────────────────────────────────────────────

export type WikiLinkSubpathKind = "heading" | "block";

export const wikiLinkSubpathKindSchema = z.enum(["heading", "block"]);

export interface ParsedWikiLinkSubpath {
	kind: WikiLinkSubpathKind;
	value: string;
}

export const parsedWikiLinkSubpathSchema = z.object({
	kind: wikiLinkSubpathKindSchema,
	value: z.string(),
});

export interface ParsedWikiLink {
	target: string;
	subpath?: ParsedWikiLinkSubpath;
	alias?: string;
	range: TextRange;
}

export const parsedWikiLinkSchema = z.object({
	target: z.string(),
	subpath: parsedWikiLinkSubpathSchema.optional(),
	alias: z.string().optional(),
	range: textRangeSchema,
});

// ─── Tags ────────────────────────────────────────────────────────────────────

export type ParsedTagSource = "frontmatter" | "body";

export const parsedTagSourceSchema = z.enum(["frontmatter", "body"]);

export interface ParsedTag {
	name: string;
	source: ParsedTagSource;
	range?: TextRange;
}

export const parsedTagSchema = z.object({
	name: z.string().min(1, "Tag name cannot be empty"),
	source: parsedTagSourceSchema,
	range: textRangeSchema.optional(),
});

// ─── Callouts ────────────────────────────────────────────────────────────────

export type ParsedCalloutFold = "+" | "-";

export const parsedCalloutFoldSchema = z.enum(["+", "-"]);

export interface ParsedCallout {
	type: string;
	fold?: ParsedCalloutFold;
	title?: string;
	range: TextRange;
}

export const parsedCalloutSchema = z.object({
	type: z.string().min(1, "Callout type cannot be empty"),
	fold: parsedCalloutFoldSchema.optional(),
	title: z.string().optional(),
	range: textRangeSchema,
});

// ─── Equations & Tables (Extended AST structures) ────────────────────────────

export interface ParsedEquation {
	type: "inline" | "block";
	content: string;
	range: TextRange;
}

export const parsedEquationSchema = z.object({
	type: z.enum(["inline", "block"]),
	content: z.string(),
	range: textRangeSchema,
});

export interface ParsedTable {
	header: string[];
	rows: string[][];
	range: TextRange;
}

export const parsedTableSchema = z.object({
	header: z.array(z.string()),
	rows: z.array(z.array(z.string())),
	range: textRangeSchema,
});

// ─── Document Root ───────────────────────────────────────────────────────────

export interface ParsedObsidianDocument {
	filePath?: string;
	frontmatter: Record<string, unknown>;
	frontmatterRange?: TextRange;
	headings: ParsedHeading[];
	sections: ParsedSection[];
	blocks: ParsedBlock[];
	wikiLinks: ParsedWikiLink[];
	tags: ParsedTag[];
	callouts: ParsedCallout[];
	equations?: ParsedEquation[];
	tables?: ParsedTable[];
}

export const parsedObsidianDocumentSchema = z.object({
	filePath: z.string().optional(),
	frontmatter: z.record(z.string(), z.unknown()),
	frontmatterRange: textRangeSchema.optional(),
	headings: z.array(parsedHeadingSchema),
	sections: z.array(parsedSectionSchema),
	blocks: z.array(parsedBlockSchema),
	wikiLinks: z.array(parsedWikiLinkSchema),
	tags: z.array(parsedTagSchema),
	callouts: z.array(parsedCalloutSchema),
	equations: z.array(parsedEquationSchema).optional(),
	tables: z.array(parsedTableSchema).optional(),
});

export function validateParsedObsidianDocument(raw: unknown): ParsedObsidianDocument {
	return parsedObsidianDocumentSchema.parse(raw);
}
