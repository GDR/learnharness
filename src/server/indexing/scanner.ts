/**
 * Document Inventory & Source Scanner.
 *
 * Scans attached Obsidian vault sources, performs SHA-256 content hashing,
 * detects changes (added, modified, unchanged, removed), enforces disconnected
 * vault safety, and atomically persists inventory state to:
 * data/projects/<projectId>/sources/<sourceId>/inventory.json
 */
import * as fs from "node:fs";
import * as path from "node:path";
import crypto from "node:crypto";
import { PATHS } from "../../../config.ts";
import {
	type SourceDocument,
	type ScanResult,
	matchesGlob,
	globToRegex,
} from "../../core/contracts/indexing.ts";
import {
	VaultNotFoundError,
	SourceNotFoundError,
} from "../../core/contracts/project.ts";
import type { ProjectStore, VaultRegistry } from "../../core/ports.ts";
import { writeAtomicJson } from "../../core/fs-atomic.ts";
import { resolveProjectSource } from "../sources.ts";
import { getVaultRegistry } from "../../store/vaults.ts";

export class VaultUnavailableError extends Error {
	readonly status = 409;
	readonly code = "VAULT_UNAVAILABLE";
	readonly vaultId: string;

	constructor(vaultId: string, message = "Vault is unavailable") {
		super(message);
		this.name = "VaultUnavailableError";
		this.vaultId = vaultId;
	}
}

import { getProjectStore } from "../projects.ts";

export function getInventoryPath(projectId: string, sourceId: string, dataDir?: string): string {
	const base = dataDir
		? path.resolve(dataDir)
		: (getProjectStore().dataDir ? path.resolve(getProjectStore().dataDir!) : PATHS.data);
	return path.join(base, "projects", projectId, "sources", sourceId, "inventory.json");
}

export async function loadSourceInventory(
	projectId: string,
	sourceId: string,
	dataDir?: string,
): Promise<Record<string, SourceDocument>> {
	const invPath = getInventoryPath(projectId, sourceId, dataDir);
	try {
		if (!fs.existsSync(invPath)) return {};
		const raw = await fs.promises.readFile(invPath, "utf-8");
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) {
			const record: Record<string, SourceDocument> = {};
			for (const doc of parsed) {
				if (doc && doc.id) record[doc.id] = doc;
			}
			return record;
		}
		if (parsed && typeof parsed === "object") {
			return parsed as Record<string, SourceDocument>;
		}
		return {};
	} catch {
		return {};
	}
}

export async function saveSourceInventory(
	projectId: string,
	sourceId: string,
	inventory: Record<string, SourceDocument>,
	dataDir?: string,
): Promise<void> {
	const invPath = getInventoryPath(projectId, sourceId, dataDir);
	await writeAtomicJson(invPath, inventory);
}

export interface ScanSourceDocumentsOptions {
	projectId: unknown;
	sourceId: unknown;
	forceRescan?: boolean;
	dataDir?: string;
	projectStore?: ProjectStore;
	vaultRegistry?: VaultRegistry;
}

/**
 * Scans an attached vault source for markdown documents, compares SHA-256 hashes
 * against the existing document inventory, computes added/modified/unchanged/removed
 * diffs, persists the updated inventory atomically, and returns the ScanResult.
 *
 * If the vault is disconnected/unavailable, throws VaultUnavailableError (HTTP 409)
 * WITHOUT modifying or removing any existing document inventory records.
 */
export async function scanSourceDocuments(
	options: ScanSourceDocumentsOptions,
): Promise<ScanResult> {
	// 1. Resolve ProjectSource and enforce project isolation (fails fast 400/404)
	const { context, source, validProjectId, validSourceId } = await resolveProjectSource(
		options.projectId,
		options.sourceId,
		{ dataDir: options.dataDir, projectStore: options.projectStore },
	);

	const effectiveDataDir =
		options.dataDir ??
		options.projectStore?.dataDir ??
		getProjectStore().dataDir ??
		PATHS.data;

	// 2. Fetch Vault from registry
	const vRegistry = options.vaultRegistry ?? getVaultRegistry(options.dataDir);
	const vault = await vRegistry.getVault(source.vaultId);
	if (!vault) {
		throw new VaultNotFoundError(source.vaultId);
	}

	// 3. Disconnected Vault Safety: check bindings
	if (typeof vRegistry.checkVaultAvailability === "function") {
		await vRegistry.checkVaultAvailability(vault.id).catch(() => {});
	}
	const refreshedVault = (await vRegistry.getVault(vault.id)) ?? vault;

	const binding =
		refreshedVault.bindings.find((b) => {
			try {
				return b.status === "available" && fs.existsSync(b.rootPath) && fs.statSync(b.rootPath).isDirectory();
			} catch {
				return false;
			}
		}) ??
		refreshedVault.bindings.find((b) => {
			try {
				return fs.existsSync(b.rootPath) && fs.statSync(b.rootPath).isDirectory();
			} catch {
				return false;
			}
		});

	if (!binding) {
		throw new VaultUnavailableError(
			vault.id,
			`Vault "${vault.displayName}" (${vault.id}) is unavailable on this machine`,
		);
	}

	const vaultRoot = path.resolve(binding.rootPath);

	// 4. Load existing stored inventory (or fall back to context.sources)
	let existingInventory = await loadSourceInventory(validProjectId, validSourceId, effectiveDataDir);
	if (Object.keys(existingInventory).length === 0) {
		const storeDocs = await context.sources.listDocuments(validSourceId).catch(() => []);
		if (storeDocs.length > 0) {
			existingInventory = Object.fromEntries(storeDocs.map((d) => [d.id, d]));
		}
	}

	const existingByPath = new Map<string, SourceDocument>();
	for (const doc of Object.values(existingInventory)) {
		existingByPath.set(doc.currentPath, doc);
	}

	// 5. Enumerate files on disk matching source include/exclude globs
	const recursive = source.recursive !== false;

	async function collectCandidateFiles(dir: string): Promise<string[]> {
		const entries = await fs.promises.readdir(dir, { withFileTypes: true });
		const results: string[] = [];

		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);
			const relPath = path.relative(vaultRoot, fullPath).replace(/\\/g, "/");

			if (entry.isDirectory()) {
				// Early directory exclusion check
				let skip = false;
				for (const pattern of source.exclude) {
					const rx = globToRegex(pattern);
					if (rx.test(relPath) || rx.test(relPath + "/") || rx.test(relPath + "/dummy.md")) {
						skip = true;
						break;
					}
				}
				if (!skip && recursive) {
					const sub = await collectCandidateFiles(fullPath);
					results.push(...sub);
				}
			} else if (entry.isFile()) {
				if (matchesGlob(relPath, source.include, source.exclude)) {
					results.push(fullPath);
				}
			}
		}

		return results;
	}

	const matchingFilePaths = await collectCandidateFiles(vaultRoot);

	// 6. Change detection
	const nowIso = new Date().toISOString();
	let addedCount = 0;
	let modifiedCount = 0;
	let unchangedCount = 0;
	let removedCount = 0;

	const seenPaths = new Set<string>();
	const updatedInventory: Record<string, SourceDocument> = {};

	for (const fullPath of matchingFilePaths) {
		const relPath = path.relative(vaultRoot, fullPath).replace(/\\/g, "/");
		seenPaths.add(relPath);

		const contentBuffer = await fs.promises.readFile(fullPath);
		const contentHash = crypto.createHash("sha256").update(contentBuffer).digest("hex");
		const stat = await fs.promises.stat(fullPath);

		const docId = `doc_${crypto
			.createHash("sha256")
			.update(`${validSourceId}:${relPath}`)
			.digest("hex")
			.slice(0, 16)}`;

		const existing = existingByPath.get(relPath);

		if (!existing) {
			// Brand new document
			addedCount++;
			const revisionId = `rev_${crypto
				.createHash("sha256")
				.update(`${contentHash}:${Date.now()}_${Math.random()}`)
				.digest("hex")
				.slice(0, 12)}`;

			const newDoc: SourceDocument = {
				id: docId,
				projectId: validProjectId,
				sourceId: validSourceId,
				vaultId: vault.id,
				currentPath: relPath,
				contentHash,
				revisionId,
				status: "active",
				sizeBytes: stat.size,
				updatedAt: nowIso,
			};
			updatedInventory[docId] = newDoc;
		} else if (existing.status === "missing") {
			// Previously missing document reappeared
			addedCount++;
			const isHashChanged = existing.contentHash !== contentHash;
			const revisionId = isHashChanged
				? `rev_${crypto
						.createHash("sha256")
						.update(`${contentHash}:${Date.now()}_${Math.random()}`)
						.digest("hex")
						.slice(0, 12)}`
				: existing.revisionId;

			const restoredDoc: SourceDocument = {
				...existing,
				id: docId,
				projectId: validProjectId,
				sourceId: validSourceId,
				vaultId: vault.id,
				currentPath: relPath,
				contentHash,
				revisionId,
				status: "active",
				sizeBytes: stat.size,
				updatedAt: nowIso,
			};
			updatedInventory[docId] = restoredDoc;
		} else if (existing.contentHash === contentHash && !options.forceRescan) {
			// Unchanged document
			unchangedCount++;
			const unchangedDoc: SourceDocument = {
				...existing,
				id: docId,
				projectId: validProjectId,
				sourceId: validSourceId,
				vaultId: vault.id,
				currentPath: relPath,
				status: "active",
				sizeBytes: stat.size,
				updatedAt: existing.updatedAt ?? nowIso,
			};
			updatedInventory[docId] = unchangedDoc;
		} else {
			// Modified document (or forceRescan)
			if (existing.contentHash !== contentHash) {
				modifiedCount++;
			} else {
				unchangedCount++;
			}

			const isHashChanged = existing.contentHash !== contentHash;
			const revisionId = isHashChanged
				? `rev_${crypto
						.createHash("sha256")
						.update(`${contentHash}:${Date.now()}_${Math.random()}`)
						.digest("hex")
						.slice(0, 12)}`
				: existing.revisionId;

			const modDoc: SourceDocument = {
				...existing,
				id: docId,
				projectId: validProjectId,
				sourceId: validSourceId,
				vaultId: vault.id,
				currentPath: relPath,
				contentHash,
				revisionId,
				status: "active",
				sizeBytes: stat.size,
				updatedAt: nowIso,
			};
			updatedInventory[docId] = modDoc;
		}
	}

	// 7. Check for removed documents (in inventory but no longer on disk)
	for (const doc of existingByPath.values()) {
		if (!seenPaths.has(doc.currentPath)) {
			if (doc.status !== "missing") {
				removedCount++;
				doc.status = "missing";
				doc.updatedAt = nowIso;
			}
			updatedInventory[doc.id] = doc;
		}
	}

	// 8. Persist updated inventory atomically to disk
	await saveSourceInventory(validProjectId, validSourceId, updatedInventory, effectiveDataDir);

	// Also sync to project context sources store
	for (const doc of Object.values(updatedInventory)) {
		await context.sources.upsertDocument(doc).catch(() => {});
	}

	return {
		sourceId: validSourceId,
		vaultId: vault.id,
		scannedCount: matchingFilePaths.length,
		addedCount,
		modifiedCount,
		unchangedCount,
		removedCount,
		documents: Object.values(updatedInventory),
	};
}
