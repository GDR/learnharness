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
	projectIdSchema,
} from "../core/contracts/project.ts";
import type { ProjectStore } from "../core/ports.ts";
import { createProjectStore } from "../store/projects.ts";
import { createChatStore } from "../store/chats.ts";
import { createGraphStore } from "../store/graph.ts";
import { createJobStore } from "../store/jobs.ts";
import { createPracticeStore } from "../store/practice.ts";
import { createSourceStore } from "../store/sources.ts";

export class InvalidProjectIdError extends Error {
	readonly status = 400;
	constructor(message = "Invalid projectId") {
		super(message);
		this.name = "InvalidProjectIdError";
	}
}

export class ProjectNotFoundError extends Error {
	readonly status = 404;
	readonly projectId: string;
	constructor(projectId: string) {
		super(`Project not found: ${projectId}`);
		this.name = "ProjectNotFoundError";
		this.projectId = projectId;
	}
}

/**
 * Validates project ID format. Throws InvalidProjectIdError (status 400)
 * on empty, missing, non-string, or regex-invalid project ID.
 */
export function validateProjectId(raw: unknown): ProjectId {
	if (typeof raw !== "string" || !raw.trim()) {
		throw new InvalidProjectIdError("projectId must be a non-empty string");
	}
	const result = projectIdSchema.safeParse(raw.trim());
	if (!result.success) {
		throw new InvalidProjectIdError(result.error.issues[0]?.message ?? `Invalid projectId format: "${String(raw)}"`);
	}
	return result.data;
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

const projectContextCache = new Map<string, ProjectContext>();

export function clearProjectContextCache(): void {
	projectContextCache.clear();
}

/**
 * Resolves a ProjectContext for the given project ID.
 * Validates the ID, retrieves the project from ProjectStore,
 * verifies existence (throwing ProjectNotFoundError with status 404 on missing),
 * and caches/instantiates project-scoped stores pointing to data/projects/<id>/.
 * Never falls back silently to other projects.
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

	const pStore = options?.projectStore ?? (options?.dataDir ? createProjectStore(options.dataDir) : getProjectStore());
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

	projectContextCache.set(cacheKey, context);
	return context;
}

interface GlobalProjectAuditLocks {
	__lhProjectAuditLocks?: Map<ProjectId, { tail: Promise<void> }>;
}

/**
 * Project-keyed writer locks replacing globalThis.__lhAuditLock.
 * Serializes audit and ledger commits per-project while allowing
 * concurrent operations across distinct projects to run in parallel.
 */
export function getProjectAuditLock(projectId: unknown): <T>(fn: () => Promise<T>) => Promise<T> {
	const validId = validateProjectId(projectId);
	const g = globalThis as typeof globalThis & GlobalProjectAuditLocks;
	const locks = (g.__lhProjectAuditLocks ??= new Map());

	let lock = locks.get(validId);
	if (!lock) {
		lock = { tail: Promise.resolve() };
		locks.set(validId, lock);
	}

	return async function withLock<T>(fn: () => Promise<T>): Promise<T> {
		const prev = lock.tail;
		let release!: () => void;
		lock.tail = new Promise<void>((resolve) => (release = resolve));
		try {
			await prev;
			return await fn();
		} finally {
			release();
		}
	};
}
