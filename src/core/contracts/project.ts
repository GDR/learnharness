/**
 * Multi-project workspace isolation and Obsidian integration contracts.
 *
 * Core domain types and Zod validation schemas for projects, vaults,
 * attached sources, document inventories, evidence tracking, study scopes,
 * and project execution contexts.
 */
import { z } from "zod";
import type {
	ChatStore,
	GraphStore,
	JobStore,
	PracticeStore,
	SourceStore,
} from "../ports.ts";

// ─── Identifier Types & Schemas ──────────────────────────────────────────────

export type ProjectId = string;
export type VaultId = string;
export type SourceId = string;
export type DocumentId = string;
export type EvidenceId = string;

export const projectIdRegex = /^[A-Za-z0-9_-]+$/;

export const projectIdSchema = z
	.string()
	.min(1, "projectId cannot be empty")
	.regex(projectIdRegex, "projectId must contain only letters, numbers, underscores, and hyphens");

export const vaultIdRegex = /^[A-Za-z0-9_-]+$/;

export const vaultIdSchema = z
	.string()
	.min(1, "vaultId cannot be empty")
	.regex(vaultIdRegex, "vaultId must contain only letters, numbers, underscores, and hyphens");

export class InvalidVaultIdError extends Error {
	readonly status = 400;
	constructor(message = "Invalid vaultId") {
		super(message);
		this.name = "InvalidVaultIdError";
	}
}

export class VaultNotFoundError extends Error {
	readonly status = 404;
	readonly vaultId: string;
	constructor(vaultId: string) {
		super(`Vault not found: ${vaultId}`);
		this.name = "VaultNotFoundError";
		this.vaultId = vaultId;
	}
}

export function validateVaultId(raw: unknown): VaultId {
	if (typeof raw !== "string" || !raw.trim()) {
		throw new InvalidVaultIdError("vaultId must be a non-empty string");
	}
	const result = vaultIdSchema.safeParse(raw.trim());
	if (!result.success) {
		throw new InvalidVaultIdError(
			result.error.issues[0]?.message ?? `Invalid vaultId format: "${String(raw)}"`,
		);
	}
	return result.data;
}

export const sourceIdSchema = z.string().min(1, "sourceId cannot be empty");
export const documentIdSchema = z.string().min(1, "documentId cannot be empty");
export const evidenceIdSchema = z.string().min(1, "evidenceId cannot be empty");

export const DEFAULT_PROJECT_ID: ProjectId = "proj_default";

// ─── Project Settings & Project ──────────────────────────────────────────────

export interface ProjectSettings {
	defaultStudyScope: "all" | "manual";
	sourceGrounding: "strict" | "assisted";
}

export const projectSettingsSchema = z.object({
	defaultStudyScope: z.enum(["all", "manual"]),
	sourceGrounding: z.enum(["strict", "assisted"]),
});

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
	defaultStudyScope: "all",
	sourceGrounding: "strict",
};

export interface Project {
	id: ProjectId;
	name: string;
	description?: string;
	status: "active" | "archived";
	createdAt: string;
	updatedAt: string;
	settings: ProjectSettings;
}

export const projectSchema = z.object({
	id: projectIdSchema,
	name: z.string().min(1, "Project name cannot be empty"),
	description: z.string().optional(),
	status: z.enum(["active", "archived"]),
	createdAt: z.string().min(1, "createdAt cannot be empty"),
	updatedAt: z.string().min(1, "updatedAt cannot be empty"),
	settings: projectSettingsSchema,
});

export interface ProjectSummary {
	id: ProjectId;
	name: string;
	description?: string;
	status: "active" | "archived";
	createdAt: string;
	updatedAt: string;
}

export const projectSummarySchema = z.object({
	id: projectIdSchema,
	name: z.string().min(1, "Project name cannot be empty"),
	description: z.string().optional(),
	status: z.enum(["active", "archived"]),
	createdAt: z.string().min(1, "createdAt cannot be empty"),
	updatedAt: z.string().min(1, "updatedAt cannot be empty"),
});

// ─── Vaults & Bindings ───────────────────────────────────────────────────────

export interface VaultBinding {
	deviceId: string;
	rootPath: string;
	status: "available" | "unavailable";
}

export const vaultBindingSchema = z.object({
	deviceId: z.string().min(1, "deviceId cannot be empty"),
	rootPath: z.string().min(1, "rootPath cannot be empty"),
	status: z.enum(["available", "unavailable"]),
});

export interface Vault {
	id: VaultId;
	displayName: string;
	kind: "obsidian";
	bindings: VaultBinding[];
}

export const vaultSchema = z.object({
	id: vaultIdSchema,
	displayName: z.string().min(1, "displayName cannot be empty"),
	kind: z.literal("obsidian"),
	bindings: z.array(vaultBindingSchema),
});

// ─── Project Sources & Documents ─────────────────────────────────────────────

export interface ProjectSource {
	id: SourceId;
	projectId: ProjectId;
	vaultId: VaultId;
	include: string[];
	exclude: string[];
	recursive: boolean;
	enabled: boolean;
	syncMode: "manual" | "automatic";
	deletionPolicy: "deactivate" | "retain";
	createdAt: string;
}

export const projectSourceSchema = z.object({
	id: sourceIdSchema,
	projectId: projectIdSchema,
	vaultId: vaultIdSchema,
	include: z.array(z.string()),
	exclude: z.array(z.string()),
	recursive: z.boolean(),
	enabled: z.boolean(),
	syncMode: z.enum(["manual", "automatic"]),
	deletionPolicy: z.enum(["deactivate", "retain"]),
	createdAt: z.string().min(1, "createdAt cannot be empty"),
});

export interface AttachedSourceScope {
	rootPath: string;
	include?: string[];
	exclude?: string[];
	recursive?: boolean;
	enabled?: boolean;
	sourceId?: SourceId;
	vaultId?: VaultId;
	projectId?: ProjectId;
}

export const attachedSourceScopeSchema = z.object({
	rootPath: z.string().min(1, "rootPath cannot be empty"),
	include: z.array(z.string()).optional(),
	exclude: z.array(z.string()).optional(),
	recursive: z.boolean().optional(),
	enabled: z.boolean().optional(),
	sourceId: sourceIdSchema.optional(),
	vaultId: vaultIdSchema.optional(),
	projectId: projectIdSchema.optional(),
});

export interface SourceDocument {
	id: DocumentId;
	sourceId: SourceId;
	vaultId: VaultId;
	currentPath: string;
	contentHash: string;
	revisionId: string;
	status: "active" | "missing" | "excluded" | "error";
	indexedAt?: string;
}

export const sourceDocumentSchema = z.object({
	id: documentIdSchema,
	sourceId: sourceIdSchema,
	vaultId: vaultIdSchema,
	currentPath: z.string().min(1, "currentPath cannot be empty"),
	contentHash: z.string().min(1, "contentHash cannot be empty"),
	revisionId: z.string().min(1, "revisionId cannot be empty"),
	status: z.enum(["active", "missing", "excluded", "error"]),
	indexedAt: z.string().optional(),
});

// ─── Source Evidence ─────────────────────────────────────────────────────────

export interface SourceEvidenceLocation {
	heading?: string;
	blockId?: string;
	startOffset?: number;
	endOffset?: number;
}

export const sourceEvidenceLocationSchema = z.object({
	heading: z.string().optional(),
	blockId: z.string().optional(),
	startOffset: z.number().int().nonnegative().optional(),
	endOffset: z.number().int().nonnegative().optional(),
});

export interface SourceEvidence {
	id: EvidenceId;
	projectId: ProjectId;
	sourceId: SourceId;
	documentId: DocumentId;
	revisionId: string;
	propositionId: string;
	location: SourceEvidenceLocation;
	provenance: "explicit-source" | "model-inferred";
	status: "active" | "superseded";
	extractorVersion: string;
}

export const sourceEvidenceSchema = z.object({
	id: evidenceIdSchema,
	projectId: projectIdSchema,
	sourceId: sourceIdSchema,
	documentId: documentIdSchema,
	revisionId: z.string().min(1, "revisionId cannot be empty"),
	propositionId: z.string().min(1, "propositionId cannot be empty"),
	location: sourceEvidenceLocationSchema,
	provenance: z.enum(["explicit-source", "model-inferred"]),
	status: z.enum(["active", "superseded"]),
	extractorVersion: z.string().min(1, "extractorVersion cannot be empty"),
});

// ─── Study Scope ─────────────────────────────────────────────────────────────

export interface StudyScope {
	projectId: ProjectId;
	sourceIds?: SourceId[];
	documentIds?: DocumentId[];
	propositionIds?: string[];
	includePrerequisites: boolean;
	grounding: "sources-only" | "sources-plus-external";
}

export const studyScopeSchema = z.object({
	projectId: projectIdSchema,
	sourceIds: z.array(sourceIdSchema).optional(),
	documentIds: z.array(documentIdSchema).optional(),
	propositionIds: z.array(z.string()).optional(),
	includePrerequisites: z.boolean(),
	grounding: z.enum(["sources-only", "sources-plus-external"]),
});

// ─── Project Context ─────────────────────────────────────────────────────────

export interface ProjectContext {
	projectId: ProjectId;
	chats: ChatStore;
	graph: GraphStore;
	jobs: JobStore;
	practice: PracticeStore;
	sources: SourceStore;
}

export const projectContextSchema = z.object({
	projectId: projectIdSchema,
	chats: z.custom<ChatStore>(
		(val) => typeof val === "object" && val !== null,
		"chats must be a ChatStore object",
	),
	graph: z.custom<GraphStore>(
		(val) => typeof val === "object" && val !== null,
		"graph must be a GraphStore object",
	),
	jobs: z.custom<JobStore>(
		(val) => typeof val === "object" && val !== null,
		"jobs must be a JobStore object",
	),
	practice: z.custom<PracticeStore>(
		(val) => typeof val === "object" && val !== null,
		"practice must be a PracticeStore object",
	),
	sources: z.custom<SourceStore>(
		(val) => typeof val === "object" && val !== null,
		"sources must be a SourceStore object",
	),
});

// ─── Legacy Migration Checkpoint ─────────────────────────────────────────────

export interface MigrationCheckpoint {
	status: "not_started" | "in_progress" | "completed" | "failed";
	startedAt?: string;
	completedAt?: string;
	migratedCounts: {
		chats: number;
		graphFiles: number;
		jobs: number;
		practice: number;
		vaults: number;
		sources: number;
	};
	error?: string;
}

export const migrationCheckpointSchema = z.object({
	status: z.enum(["not_started", "in_progress", "completed", "failed"]),
	startedAt: z.string().optional(),
	completedAt: z.string().optional(),
	migratedCounts: z.object({
		chats: z.number().int().nonnegative(),
		graphFiles: z.number().int().nonnegative(),
		jobs: z.number().int().nonnegative(),
		practice: z.number().int().nonnegative(),
		vaults: z.number().int().nonnegative(),
		sources: z.number().int().nonnegative(),
	}),
	error: z.string().optional(),
});

