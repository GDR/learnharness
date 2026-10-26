/**
 * ProjectStore — file-backed implementation of the ProjectStore port.
 *
 * Manages global project registry (data/global/projects.json) and per-project
 * metadata (data/projects/<id>/project.json) using crash-safe atomic writes.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PATHS } from "../../config.ts";
import {
	type Project,
	type ProjectId,
	type ProjectSettings,
	type ProjectSummary,
	DEFAULT_PROJECT_ID,
	DEFAULT_PROJECT_SETTINGS,
	projectIdRegex,
	projectSchema,
} from "../core/contracts/project.ts";
import type { ProjectStore, ProjectPatch } from "../core/ports.ts";
import { writeAtomicJson } from "../core/fs-atomic.ts";

interface GlobalProjectsRecord {
	version: number;
	activeProjectId: ProjectId | null;
	projects: ProjectSummary[];
}

export function createProjectStore(customDataDir?: string): ProjectStore {
	const dataDir = customDataDir ? path.resolve(customDataDir) : PATHS.data;
	const globalDir = path.join(dataDir, "global");
	const projectsBaseDir = path.join(dataDir, "projects");
	const globalFile = path.join(globalDir, "projects.json");

	let writeQueue = Promise.resolve();
	function withLock<T>(fn: () => Promise<T>): Promise<T> {
		const next = writeQueue.then(fn, fn);
		writeQueue = next.then(() => {}, () => {});
		return next;
	}

	function projectFile(id: ProjectId): string {
		return path.join(projectsBaseDir, id, "project.json");
	}

	function projectDirectory(id: ProjectId): string {
		return path.join(projectsBaseDir, id);
	}

	async function readGlobalRecord(): Promise<GlobalProjectsRecord> {
		try {
			if (!fs.existsSync(globalFile)) {
				return { version: 1, activeProjectId: null, projects: [] };
			}
			const raw = await fs.promises.readFile(globalFile, "utf8");
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed)) {
				return {
					version: 1,
					activeProjectId: parsed[0]?.id ?? null,
					projects: parsed,
				};
			}
			return {
				version: parsed.version ?? 1,
				activeProjectId: parsed.activeProjectId ?? null,
				projects: Array.isArray(parsed.projects) ? parsed.projects : [],
			};
		} catch {
			return { version: 1, activeProjectId: null, projects: [] };
		}
	}

	async function writeGlobalRecord(record: GlobalProjectsRecord): Promise<void> {
		await writeAtomicJson(globalFile, record);
	}

	async function getProject(id: ProjectId): Promise<Project | null> {
		if (!id || typeof id !== "string" || !projectIdRegex.test(id)) {
			return null;
		}

		const pFile = projectFile(id);
		try {
			if (fs.existsSync(pFile)) {
				const raw = await fs.promises.readFile(pFile, "utf8");
				const parsed = JSON.parse(raw);
				const validated = projectSchema.safeParse(parsed);
				if (validated.success) {
					return validated.data;
				}
			}
		} catch {
			// fall through to global record check
		}

		const globalRecord = await readGlobalRecord();
		const summary = globalRecord.projects.find((p) => p.id === id);
		if (!summary) {
			return null;
		}

		// Synthesize project from summary if per-project file is missing
		const fallback: Project = {
			id: summary.id,
			name: summary.name,
			...(summary.description ? { description: summary.description } : {}),
			status: summary.status,
			createdAt: summary.createdAt,
			updatedAt: summary.updatedAt,
			settings: { ...DEFAULT_PROJECT_SETTINGS },
		};
		return fallback;
	}

	async function listProjects(): Promise<Project[]> {
		const globalRecord = await readGlobalRecord();
		const results: Project[] = [];

		for (const summary of globalRecord.projects) {
			const project = await getProject(summary.id);
			if (project) {
				results.push(project);
			} else {
				results.push({
					id: summary.id,
					name: summary.name,
					...(summary.description ? { description: summary.description } : {}),
					status: summary.status,
					createdAt: summary.createdAt,
					updatedAt: summary.updatedAt,
					settings: { ...DEFAULT_PROJECT_SETTINGS },
				});
			}
		}

		return results;
	}

	async function createProject(input: {
		name: string;
		description?: string;
		settings?: Partial<ProjectSettings>;
		id?: ProjectId;
	}): Promise<Project> {
		return withLock(async () => {
			const trimmedName = input.name ? input.name.trim() : "";
			if (!trimmedName) {
				throw new Error("Project name cannot be empty");
			}

			let id: ProjectId;
			if (input.id) {
				if (!projectIdRegex.test(input.id)) {
					throw new Error(`Invalid projectId format: "${input.id}"`);
				}
				id = input.id;
			} else {
				id = `proj_${crypto.randomUUID().slice(0, 8)}`;
			}

			const existing = await getProject(id);
			if (existing) {
				throw new Error(`Project with id "${id}" already exists`);
			}

			const now = new Date().toISOString();
			const desc = input.description?.trim();
			const project: Project = {
				id,
				name: trimmedName,
				...(desc ? { description: desc } : {}),
				status: "active",
				createdAt: now,
				updatedAt: now,
				settings: {
					defaultStudyScope:
						input.settings?.defaultStudyScope ?? DEFAULT_PROJECT_SETTINGS.defaultStudyScope,
					sourceGrounding:
						input.settings?.sourceGrounding ?? DEFAULT_PROJECT_SETTINGS.sourceGrounding,
				},
			};

			// Validate project contract
			projectSchema.parse(project);

			// Initialize project directory structure
			const pDir = projectDirectory(id);
			await fs.promises.mkdir(pDir, { recursive: true });
			const subdirs = ["chats", "graph", "jobs", "practice", "sources", "index"];
			for (const subdir of subdirs) {
				await fs.promises.mkdir(path.join(pDir, subdir), { recursive: true });
			}

			// Atomically write per-project project.json
			await writeAtomicJson(projectFile(id), project);

			// Atomically update global registry
			const globalRecord = await readGlobalRecord();
			const summary: ProjectSummary = {
				id: project.id,
				name: project.name,
				...(project.description ? { description: project.description } : {}),
				status: project.status,
				createdAt: project.createdAt,
				updatedAt: project.updatedAt,
			};

			const filtered = globalRecord.projects.filter((p) => p.id !== id);
			filtered.push(summary);

			globalRecord.projects = filtered;
			if (!globalRecord.activeProjectId) {
				globalRecord.activeProjectId = id;
			}
			await writeGlobalRecord(globalRecord);

			return project;
		});
	}

	async function updateProject(
		id: ProjectId,
		patch: ProjectPatch,
	): Promise<Project> {
		return withLock(async () => {
			const existing = await getProject(id);
			if (!existing) {
				throw new Error(`Project not found: ${id}`);
			}

			const now = new Date().toISOString();
			const desc =
				patch.description !== undefined
					? patch.description?.trim() || undefined
					: existing.description;

			const updated: Project = {
				id: existing.id,
				name: patch.name !== undefined ? patch.name.trim() : existing.name,
				...(desc ? { description: desc } : {}),
				status: patch.status ?? existing.status,
				createdAt: existing.createdAt,
				updatedAt: now,
				settings: {
					...existing.settings,
					...(patch.settings ?? {}),
				},
			};

			if (!updated.name) {
				throw new Error("Project name cannot be empty");
			}

			projectSchema.parse(updated);

			// Write per-project file atomically
			await writeAtomicJson(projectFile(id), updated);

			// Update global summary atomically
			const globalRecord = await readGlobalRecord();
			const summaryIndex = globalRecord.projects.findIndex((p) => p.id === id);
			const summary: ProjectSummary = {
				id: updated.id,
				name: updated.name,
				...(updated.description ? { description: updated.description } : {}),
				status: updated.status,
				createdAt: updated.createdAt,
				updatedAt: updated.updatedAt,
			};

			if (summaryIndex >= 0) {
				globalRecord.projects[summaryIndex] = summary;
			} else {
				globalRecord.projects.push(summary);
			}

			await writeGlobalRecord(globalRecord);
			return updated;
		});
	}

	async function archiveProject(id: ProjectId): Promise<void> {
		await updateProject(id, { status: "archived" });
	}

	async function deleteProject(id: ProjectId): Promise<boolean> {
		return withLock(async () => {
			const existing = await getProject(id);
			if (!existing) {
				return false;
			}

			const globalRecord = await readGlobalRecord();
			globalRecord.projects = globalRecord.projects.filter((p) => p.id !== id);
			if (globalRecord.activeProjectId === id) {
				const nextActive = globalRecord.projects.find((p) => p.status === "active");
				globalRecord.activeProjectId = nextActive ? nextActive.id : null;
			}
			await writeGlobalRecord(globalRecord);

			const pDir = projectDirectory(id);
			try {
				await fs.promises.rm(pDir, { recursive: true, force: true });
			} catch {
				// ignore filesystem deletion failure
			}

			return true;
		});
	}

	async function getActiveProjectId(): Promise<ProjectId | null> {
		const record = await readGlobalRecord();
		if (record.activeProjectId) {
			const proj = await getProject(record.activeProjectId);
			if (proj && proj.status === "active") {
				return proj.id;
			}
		}
		const firstActive = record.projects.find((p) => p.status === "active");
		return firstActive?.id ?? null;
	}

	async function setActiveProjectId(id: ProjectId): Promise<void> {
		return withLock(async () => {
			const proj = await getProject(id);
			if (!proj) {
				throw new Error(`Cannot set active project: project "${id}" not found`);
			}
			const record = await readGlobalRecord();
			record.activeProjectId = id;
			await writeGlobalRecord(record);
		});
	}

	return {
		listProjects,
		getProject,
		createProject,
		updateProject,
		archiveProject,
		deleteProject,
		getActiveProjectId,
		setActiveProjectId,
	};
}

export const projectStore = createProjectStore();
