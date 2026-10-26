/**
 * Server Project Context Resolution & Project-Keyed Audit Locks.
 *
 * Enforces multi-project workspace isolation: validates project identifiers,
 * resolves project-scoped storage contexts pointing to data/projects/<id>/,
 * and serializes graph-mutating audits on a per-project basis so distinct
 * projects run concurrent extractions in parallel.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import {
	type ProjectId,
	type ProjectContext,
	type AttachedSourceScope,
	DEFAULT_PROJECT_ID,
} from "../core/contracts/project.ts";
import {
	InvalidProjectIdError,
	validateProjectId,
	getProjectAuditLock,
} from "../core/audit-lock.ts";
import type { ProjectStore, VaultRegistry } from "../core/ports.ts";
import { createProjectStore } from "../store/projects.ts";
import { createChatStore } from "../store/chats.ts";
import { createGraphStore } from "../store/graph.ts";
import { createJobStore } from "../store/jobs.ts";
import { createPracticeStore } from "../store/practice.ts";
import { createSourceStore } from "../store/sources.ts";
import { getVaultRegistry } from "../store/vaults.ts";

export { InvalidProjectIdError, validateProjectId, getProjectAuditLock, createProjectStore };

export class ProjectNotFoundError extends Error {
	readonly status = 404;
	readonly projectId: string;
	constructor(projectId: string) {
		super(`Project not found: ${projectId}`);
		this.name = "ProjectNotFoundError";
		this.projectId = projectId;
	}
}

let defaultProjectStore: ProjectStore | null = null;

export function getProjectStore(customDataDir?: string): ProjectStore {
	if (customDataDir) return createProjectStore(customDataDir);
	return (defaultProjectStore ??= createProjectStore());
}

export function setProjectStore(store: ProjectStore | null): void {
	defaultProjectStore = store;
}

interface ProjectContextResolutionOptions {
	dataDir?: string;
	projectStore?: ProjectStore;
}

const projectContextCache = new Map<string, Promise<ProjectContext>>();

export function clearProjectContextCache(): void {
	projectContextCache.clear();
}

/**
 * Resolves a ProjectContext for the given project ID.
 * Validates the ID, retrieves the project from ProjectStore,
 * verifies existence (throwing ProjectNotFoundError with status 404 on missing),
 * and caches/instantiates project-scoped stores pointing to data/projects/<id>/.
 * Never falls back silently to other projects.
 *
 * In-flight resolution promises are cached to eliminate concurrent resolution stampedes.
 */
export async function resolveProjectContext(
	projectId: unknown,
	options?: ProjectContextResolutionOptions,
): Promise<ProjectContext> {
	const validId = validateProjectId(projectId);
	const dataDir = options?.dataDir ? path.resolve(options.dataDir) : PATHS.data;
	const cacheKey = `${dataDir}:${validId}`;

	const cached = projectContextCache.get(cacheKey);
	if (cached) {
		return cached;
	}

	const resolutionPromise = (async () => {
		const pStore =
			options?.projectStore ?? (options?.dataDir ? createProjectStore(options.dataDir) : getProjectStore());
		const project = await pStore.getProject(validId);
		if (!project) {
			throw new ProjectNotFoundError(validId);
		}

		const projectDir = path.join(dataDir, "projects", validId);
		const chatsDir = path.join(projectDir, "chats");
		const graphDir = path.join(projectDir, "graph");
		const jobsDir = path.join(projectDir, "jobs");
		const practiceDir = path.join(projectDir, "practice");
		const sourcesDir = path.join(projectDir, "sources");

		fs.mkdirSync(chatsDir, { recursive: true });
		fs.mkdirSync(graphDir, { recursive: true });
		fs.mkdirSync(jobsDir, { recursive: true });
		fs.mkdirSync(practiceDir, { recursive: true });
		fs.mkdirSync(sourcesDir, { recursive: true });

		const context: ProjectContext = {
			projectId: validId,
			chats: createChatStore(chatsDir),
			graph: createGraphStore(graphDir),
			jobs: createJobStore(jobsDir),
			practice: createPracticeStore(practiceDir),
			sources: createSourceStore(sourcesDir),
		};

		return context;
	})();

	projectContextCache.set(cacheKey, resolutionPromise);

	try {
		return await resolutionPromise;
	} catch (err) {
		projectContextCache.delete(cacheKey);
		throw err;
	}
}

/**
 * Resolves all attached source scopes for a specific project.
 * Inspects the project's sources, finds each source's bound vault,
 * and produces AttachedSourceScope entries for write/edit tool confinement.
 */
export async function resolveProjectSourceScopes(
	projectId: unknown,
	options?: { dataDir?: string; vaultRegistry?: VaultRegistry },
): Promise<AttachedSourceScope[]> {
	const validId = validateProjectId(projectId);
	const context = await resolveProjectContext(validId, options);
	const sources = await context.sources.listSources(validId);
	const vRegistry = options?.vaultRegistry ?? getVaultRegistry(options?.dataDir);
	const vaults = await vRegistry.listVaults();
	const vaultMap = new Map(vaults.map((v) => [v.id, v]));

	const scopes: AttachedSourceScope[] = [];
	for (const source of sources) {
		const vault = vaultMap.get(source.vaultId);
		if (!vault) continue;
		for (const binding of vault.bindings) {
			scopes.push({
				rootPath: binding.rootPath,
				include: source.include,
				exclude: source.exclude,
				recursive: source.recursive,
				enabled: source.enabled && binding.status === "available",
				sourceId: source.id,
				vaultId: source.vaultId,
				projectId: source.projectId,
			});
		}
	}
	return scopes;
}

/**
 * Resolves attached source scopes for the active project.
 * Falls back to DEFAULT_PROJECT_ID if no active project is designated.
 */
export async function resolveActiveProjectSourceScopes(
	options?: { dataDir?: string; vaultRegistry?: VaultRegistry },
): Promise<AttachedSourceScope[]> {
	const pStore = options?.dataDir ? createProjectStore(options.dataDir) : getProjectStore();
	const activeId = (await pStore.getActiveProjectId()) ?? DEFAULT_PROJECT_ID;
	return resolveProjectSourceScopes(activeId, options);
}

/**
 * Resolves effective attached source scopes for the active project,
 * optionally falling back to configured legacy obsidianFolders if no project sources exist.
 */
export async function resolveActiveProjectEffectiveScopes(
	options?: { dataDir?: string; vaultRegistry?: VaultRegistry; obsidianFolders?: readonly string[] },
): Promise<AttachedSourceScope[]> {
	try {
		const scopes = await resolveActiveProjectSourceScopes(options);
		if (scopes.length > 0) return scopes;
	} catch (err) {
		console.warn(`[projects] failed to resolve active project source scopes:`, err);
	}
	if (options?.obsidianFolders && options.obsidianFolders.length > 0) {
		return options.obsidianFolders.map((f) => ({
			rootPath: f,
			recursive: true,
			enabled: true,
			include: ["**/*"],
			exclude: [],
		}));
	}
	return [];
}
