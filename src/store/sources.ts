/**
 * SourceStore — file-backed implementation of the SourceStore port.
 *
 * Manages project-scoped sources and document inventories in data/projects/<id>/sources/.
 * Uses crash-safe POSIX atomic writes (writeAtomicJson).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import crypto from "node:crypto";
import type { SourceStore } from "../core/ports.ts";
import {
	type ProjectId,
	type SourceId,
	type ProjectSource,
	type DocumentId,
	type SourceDocument,
	projectSourceSchema,
	sourceDocumentSchema,
	validateSourceId,
	SourceNotFoundError,
	DEFAULT_SOURCE_EXCLUDE,
	DEFAULT_SOURCE_INCLUDE,
} from "../core/contracts/project.ts";
import { writeAtomicJson } from "../core/fs-atomic.ts";

type StoredDocument = SourceDocument;

/**
 * Normalizes a single glob pattern:
 * - Trims leading and trailing whitespace
 * - Converts Windows-style backslashes to forward slashes
 * - Collapses consecutive forward slashes into a single slash (e.g. `docs//**` -> `docs/**`)
 */
export function normalizeGlob(pattern: string): string {
	if (typeof pattern !== "string") return "";
	return pattern.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
}

/**
 * Normalizes an array of glob patterns, trimming, collapsing slashes,
 * and filtering out any empty strings.
 */
export function normalizeGlobs(patterns: readonly string[]): string[] {
	if (!Array.isArray(patterns)) return [];
	return patterns
		.map(normalizeGlob)
		.filter((p) => p.length > 0);
}

export type AddSourceInput = {
	projectId: ProjectId;
	vaultId: string;
	include?: string[];
	exclude?: string[];
	recursive?: boolean;
	enabled?: boolean;
	syncMode?: "manual" | "automatic";
	deletionPolicy?: "deactivate" | "retain";
	id?: SourceId;
};

export function createSourceStore(sourcesDir: string): SourceStore {
	const resolvedSourcesDir = path.resolve(sourcesDir);
	const sourcesFile = path.join(resolvedSourcesDir, "sources.json");
	const documentsFile = path.join(resolvedSourcesDir, "documents.json");

	let writeQueue = Promise.resolve();
	function withLock<T>(fn: () => Promise<T>): Promise<T> {
		const next = writeQueue.then(fn, fn);
		writeQueue = next.then(() => {}, () => {});
		return next;
	}

	async function readSourcesRecord(): Promise<Record<SourceId, ProjectSource>> {
		try {
			if (!fs.existsSync(sourcesFile)) return {};
			const raw = await fs.promises.readFile(sourcesFile, "utf-8");
			const parsed = JSON.parse(raw);
			return typeof parsed === "object" && parsed !== null ? parsed : {};
		} catch {
			return {};
		}
	}

	async function writeSourcesRecord(record: Record<SourceId, ProjectSource>): Promise<void> {
		fs.mkdirSync(resolvedSourcesDir, { recursive: true });
		await writeAtomicJson(sourcesFile, record);
	}

	async function readDocumentsRecord(): Promise<Record<DocumentId, StoredDocument>> {
		try {
			if (!fs.existsSync(documentsFile)) return {};
			const raw = await fs.promises.readFile(documentsFile, "utf-8");
			const parsed = JSON.parse(raw);
			return typeof parsed === "object" && parsed !== null ? parsed : {};
		} catch {
			return {};
		}
	}

	async function writeDocumentsRecord(record: Record<DocumentId, StoredDocument>): Promise<void> {
		fs.mkdirSync(resolvedSourcesDir, { recursive: true });
		await writeAtomicJson(documentsFile, record);
	}

	async function listSources(projectId: ProjectId): Promise<ProjectSource[]> {
		const sources = await readSourcesRecord();
		return Object.values(sources).filter((s) => s.projectId === projectId);
	}

	async function getSource(id: SourceId): Promise<ProjectSource | null> {
		const sources = await readSourcesRecord();
		return sources[id] ?? null;
	}

	async function addSource(source: AddSourceInput): Promise<ProjectSource> {
		return withLock(async () => {
			const sources = await readSourcesRecord();
			const now = new Date().toISOString();
			const id: SourceId = source.id
				? validateSourceId(source.id)
				: `src_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;

			const rawInclude = source.include ? normalizeGlobs(source.include) : [];
			const rawExclude = source.exclude ? normalizeGlobs(source.exclude) : [];
			const include = rawInclude.length > 0 ? rawInclude : [...DEFAULT_SOURCE_INCLUDE];
			const exclude = rawExclude.length > 0 ? rawExclude : [...DEFAULT_SOURCE_EXCLUDE];

			const newSource: ProjectSource = {
				id,
				projectId: source.projectId,
				vaultId: source.vaultId,
				include,
				exclude,
				recursive: source.recursive ?? true,
				enabled: source.enabled ?? true,
				syncMode: source.syncMode ?? "manual",
				deletionPolicy: source.deletionPolicy ?? "deactivate",
				createdAt: now,
			};

			projectSourceSchema.parse(newSource);
			sources[id] = newSource;
			await writeSourcesRecord(sources);
			return newSource;
		});
	}

	async function updateSource(
		id: SourceId,
		patch: Partial<Omit<ProjectSource, "id" | "projectId" | "createdAt">>,
	): Promise<ProjectSource> {
		return withLock(async () => {
			const sources = await readSourcesRecord();
			const existing = sources[id];
			if (!existing) {
				throw new SourceNotFoundError(id);
			}

			let include = existing.include;
			if (patch.include !== undefined) {
				const normalized = normalizeGlobs(patch.include);
				include = normalized.length > 0 ? normalized : [...DEFAULT_SOURCE_INCLUDE];
			}

			let exclude = existing.exclude;
			if (patch.exclude !== undefined) {
				const normalized = normalizeGlobs(patch.exclude);
				exclude = normalized.length > 0 ? normalized : [...DEFAULT_SOURCE_EXCLUDE];
			}

			const updated: ProjectSource = {
				...existing,
				...patch,
				include,
				exclude,
				id: existing.id,
				projectId: existing.projectId,
				createdAt: existing.createdAt,
			};

			projectSourceSchema.parse(updated);
			sources[id] = updated;
			await writeSourcesRecord(sources);
			return updated;
		});
	}

	async function removeSource(id: SourceId): Promise<void> {
		return withLock(async () => {
			const sources = await readSourcesRecord();
			if (sources[id]) {
				delete sources[id];
				await writeSourcesRecord(sources);
			}

			const docs = await readDocumentsRecord();
			let changed = false;
			for (const [docId, doc] of Object.entries(docs)) {
				if (doc.sourceId === id) {
					delete docs[docId];
					changed = true;
				}
			}
			if (changed) {
				await writeDocumentsRecord(docs);
			}
		});
	}

	async function listDocuments(sourceId: SourceId): Promise<SourceDocument[]> {
		const docs = await readDocumentsRecord();
		return Object.values(docs).filter((d) => d.sourceId === sourceId);
	}

	async function upsertDocument(doc: SourceDocument): Promise<void> {
		return withLock(async () => {
			sourceDocumentSchema.parse(doc);
			const docs = await readDocumentsRecord();
			docs[doc.id] = doc;
			await writeDocumentsRecord(docs);
		});
	}

	return {
		listSources,
		getSource,
		addSource,
		updateSource,
		removeSource,
		listDocuments,
		upsertDocument,
	};
}
