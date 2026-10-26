/**
 * Idempotent, Restart-Safe Legacy Migration Engine.
 *
 * Migrates LearnHarness single-project data (chats, graph ledgers, sub-agent jobs,
 * practice sets, and obsidianFolders) into the default project (`proj_default`)
 * and global registries (`data/global/vaults.json`, `data/global/projects.json`).
 *
 * Checkpointed via `data/global/migration.json` to survive unexpected process exits
 * and guarantee safe replayability without data corruption or duplication.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import crypto from "node:crypto";
import { PATHS } from "../../../config.ts";
import {
	type MigrationCheckpoint,
	type ProjectStore,
	type VaultRegistry,
} from "../../core/ports.ts";
import {
	DEFAULT_PROJECT_ID,
	migrationCheckpointSchema,
} from "../../core/contracts/project.ts";
import { writeAtomicJson, writeAtomicFileSync } from "../../core/fs-atomic.ts";
import { createProjectStore } from "../../store/projects.ts";
import { createVaultRegistry } from "../../store/vaults.ts";
import { createSourceStore } from "../../store/sources.ts";

export interface LegacyMigrationOptions {
	dataDir?: string;
	force?: boolean;
	projectStore?: ProjectStore;
	vaultRegistry?: VaultRegistry;
}

export interface MigrationResult {
	migrated: boolean;
	checkpoint: MigrationCheckpoint;
}

function emptyCheckpoint(): MigrationCheckpoint {
	return {
		status: "not_started",
		migratedCounts: {
			chats: 0,
			graphFiles: 0,
			jobs: 0,
			practice: 0,
			vaults: 0,
			sources: 0,
		},
	};
}

export function getMigrationCheckpointPath(dataDir: string = PATHS.data): string {
	return path.join(path.resolve(dataDir), "global", "migration.json");
}

export async function readMigrationCheckpoint(dataDir: string = PATHS.data): Promise<MigrationCheckpoint | null> {
	const checkpointFile = getMigrationCheckpointPath(dataDir);
	try {
		if (!fs.existsSync(checkpointFile)) return null;
		const raw = await fs.promises.readFile(checkpointFile, "utf-8");
		const parsed = JSON.parse(raw);
		const result = migrationCheckpointSchema.safeParse(parsed);
		return result.success ? result.data : null;
	} catch {
		return null;
	}
}

/**
 * Checks if legacy data exists in the specified data directory.
 */
export function hasLegacyData(dataDir: string = PATHS.data): boolean {
	const resolved = path.resolve(dataDir);
	const legacyDirs = ["chats", "graph", "jobs", "practice"];
	for (const dir of legacyDirs) {
		const p = path.join(resolved, dir);
		if (fs.existsSync(p)) {
			try {
				const entries = fs.readdirSync(p);
				if (entries.length > 0) return true;
			} catch {
				// unreadable directory
			}
		}
	}

	const settingsFile = path.join(resolved, "settings.json");
	if (fs.existsSync(settingsFile)) {
		try {
			const raw = fs.readFileSync(settingsFile, "utf-8");
			const parsed = JSON.parse(raw);
			if (parsed?.agent?.obsidianFolders?.length > 0 || parsed?.obsidianFolders?.length > 0) {
				return true;
			}
		} catch {
			// ignore
		}
	}

	return false;
}

/**
 * Runs the legacy single-project to multi-project workspace migration.
 * Idempotent: safe to run multiple times, resume from interruptions, or run on fresh installs.
 */
export async function runLegacyMigration(options?: LegacyMigrationOptions): Promise<MigrationResult> {
	const dataDir = options?.dataDir ? path.resolve(options.dataDir) : PATHS.data;
	const globalDir = path.join(dataDir, "global");
	const checkpointFile = path.join(globalDir, "migration.json");

	const existingCheckpoint = await readMigrationCheckpoint(dataDir);
	if (existingCheckpoint?.status === "completed" && !options?.force) {
		return { migrated: false, checkpoint: existingCheckpoint };
	}

	const pStore = options?.projectStore ?? createProjectStore(dataDir);
	const vRegistry = options?.vaultRegistry ?? createVaultRegistry(dataDir);

	// If no legacy data exists, mark completed if not already marked and return
	if (!hasLegacyData(dataDir) && !options?.force) {
		const projects = await pStore.listProjects();
		if (projects.some((p) => p.id === DEFAULT_PROJECT_ID)) {
			const cleanCheckpoint: MigrationCheckpoint = {
				status: "completed",
				completedAt: new Date().toISOString(),
				migratedCounts: {
					chats: 0,
					graphFiles: 0,
					jobs: 0,
					practice: 0,
					vaults: 0,
					sources: 0,
				},
			};
			fs.mkdirSync(globalDir, { recursive: true });
			await writeAtomicJson(checkpointFile, cleanCheckpoint);
			return { migrated: false, checkpoint: cleanCheckpoint };
		}
	}

	// Begin or resume migration
	const checkpoint: MigrationCheckpoint = existingCheckpoint
		? { ...existingCheckpoint, status: "in_progress" }
		: {
				...emptyCheckpoint(),
				status: "in_progress",
				startedAt: new Date().toISOString(),
		  };

	fs.mkdirSync(globalDir, { recursive: true });
	await writeAtomicJson(checkpointFile, checkpoint);

	try {
		// 1. Ensure DEFAULT_PROJECT_ID ("proj_default") exists in ProjectStore
		let defaultProject = await pStore.getProject(DEFAULT_PROJECT_ID);
		if (!defaultProject) {
			defaultProject = await pStore.createProject({
				id: DEFAULT_PROJECT_ID,
				name: "Default Project",
				description: "Migrated from legacy LearnHarness single-project storage",
			});
		}

		const activeId = await pStore.getActiveProjectId();
		if (!activeId) {
			await pStore.setActiveProjectId(DEFAULT_PROJECT_ID);
		}

		const projectDir = path.join(dataDir, "projects", DEFAULT_PROJECT_ID);
		const targetChatsDir = path.join(projectDir, "chats");
		const targetGraphDir = path.join(projectDir, "graph");
		const targetJobsDir = path.join(projectDir, "jobs");
		const targetPracticeDir = path.join(projectDir, "practice");
		const targetSourcesDir = path.join(projectDir, "sources");

		fs.mkdirSync(targetChatsDir, { recursive: true });
		fs.mkdirSync(targetGraphDir, { recursive: true });
		fs.mkdirSync(targetJobsDir, { recursive: true });
		fs.mkdirSync(targetPracticeDir, { recursive: true });
		fs.mkdirSync(targetSourcesDir, { recursive: true });

		// 2. Migrate legacy obsidianFolders from settings into VaultRegistry & ProjectSources
		const settingsFile = path.join(dataDir, "settings.json");
		let obsidianFolders: string[] = [];
		if (fs.existsSync(settingsFile)) {
			try {
				const raw = await fs.promises.readFile(settingsFile, "utf-8");
				const parsed = JSON.parse(raw);
				const folders = parsed?.agent?.obsidianFolders ?? parsed?.obsidianFolders;
				if (Array.isArray(folders)) {
					obsidianFolders = folders.filter((f) => typeof f === "string" && f.trim()).map((f) => f.trim());
				}
			} catch {
				// invalid JSON in legacy settings is handled safely
			}
		}

		if (obsidianFolders.length > 0) {
			const sourceStore = createSourceStore(targetSourcesDir);
			const existingVaults = await vRegistry.listVaults();
			const existingSources = await sourceStore.listSources(DEFAULT_PROJECT_ID);

			for (const folder of obsidianFolders) {
				const resolvedRoot = path.resolve(folder);
				let vault = existingVaults.find((v) =>
					v.bindings.some((b) => path.resolve(b.rootPath) === resolvedRoot),
				);

				if (!vault) {
					const deterministicVaultId = `vault_${crypto
						.createHash("sha256")
						.update(resolvedRoot)
						.digest("hex")
						.slice(0, 8)}`;

					const existingById = await vRegistry.getVault(deterministicVaultId);
					if (existingById) {
						vault = existingById;
					} else {
						const isAvailable = fs.existsSync(resolvedRoot);
						vault = await vRegistry.registerVault({
							id: deterministicVaultId,
							displayName: path.basename(resolvedRoot) || "Obsidian Vault",
							kind: "obsidian",
							bindings: [
								{
									deviceId: "local",
									rootPath: resolvedRoot,
									status: isAvailable ? "available" : "unavailable",
								},
							],
						});
						checkpoint.migratedCounts.vaults++;
					}
				}

				// Attach as ProjectSource to default project if not already attached
				const hasSource = existingSources.some((s) => s.vaultId === vault.id);
				if (!hasSource) {
					await sourceStore.addSource({
						projectId: DEFAULT_PROJECT_ID,
						vaultId: vault.id,
						include: ["**/*.md"],
						exclude: [".obsidian/**", ".trash/**", ".git/**"],
						recursive: true,
						enabled: true,
						syncMode: "manual",
						deletionPolicy: "retain",
					});
					checkpoint.migratedCounts.sources++;
				}
			}
		}

		// 3. Migrate legacy chat sessions
		const legacyChatsDir = path.join(dataDir, "chats");
		if (fs.existsSync(legacyChatsDir)) {
			const chatFiles = await fs.promises.readdir(legacyChatsDir);
			for (const file of chatFiles) {
				if (!file.endsWith(".json")) continue;
				const src = path.join(legacyChatsDir, file);
				const dest = path.join(targetChatsDir, file);
				if (shouldCopy(src, dest)) {
					const content = await fs.promises.readFile(src);
					writeAtomicFileSync(dest, content);
					checkpoint.migratedCounts.chats++;
				}
			}
		}

		// 4. Migrate legacy graph ledgers and format files
		const legacyGraphDir = path.join(dataDir, "graph");
		if (fs.existsSync(legacyGraphDir)) {
			const graphFiles = await fs.promises.readdir(legacyGraphDir);
			for (const file of graphFiles) {
				const src = path.join(legacyGraphDir, file);
				const stat = await fs.promises.stat(src);
				if (!stat.isFile()) continue;
				const dest = path.join(targetGraphDir, file);
				if (shouldCopy(src, dest)) {
					const content = await fs.promises.readFile(src);
					writeAtomicFileSync(dest, content);
					checkpoint.migratedCounts.graphFiles++;
				}
			}
		}

		// 5. Migrate legacy sub-agent jobs
		const legacyJobsDir = path.join(dataDir, "jobs");
		if (fs.existsSync(legacyJobsDir)) {
			const jobFiles = await fs.promises.readdir(legacyJobsDir);
			for (const file of jobFiles) {
				if (!file.endsWith(".json")) continue;
				const src = path.join(legacyJobsDir, file);
				const dest = path.join(targetJobsDir, file);
				if (shouldCopy(src, dest)) {
					const content = await fs.promises.readFile(src);
					writeAtomicFileSync(dest, content);
					checkpoint.migratedCounts.jobs++;
				}
			}
		}

		// 6. Migrate legacy practice sets
		const legacyPracticeDir = path.join(dataDir, "practice");
		if (fs.existsSync(legacyPracticeDir)) {
			const practiceFiles = await fs.promises.readdir(legacyPracticeDir);
			for (const file of practiceFiles) {
				if (!file.endsWith(".json")) continue;
				const src = path.join(legacyPracticeDir, file);
				const dest = path.join(targetPracticeDir, file);
				if (shouldCopy(src, dest)) {
					const content = await fs.promises.readFile(src);
					writeAtomicFileSync(dest, content);
					checkpoint.migratedCounts.practice++;
				}
			}
		}

		// 7. Checkpoint completion
		checkpoint.status = "completed";
		checkpoint.completedAt = new Date().toISOString();
		delete checkpoint.error;

		await writeAtomicJson(checkpointFile, checkpoint);
		return { migrated: true, checkpoint };
	} catch (err) {
		checkpoint.status = "failed";
		checkpoint.error = err instanceof Error ? err.message : String(err);
		try {
			await writeAtomicJson(checkpointFile, checkpoint);
		} catch {
			// ignore secondary write failure
		}
		throw err;
	}
}

function shouldCopy(src: string, dest: string): boolean {
	if (!fs.existsSync(dest)) return true;
	try {
		const srcStat = fs.statSync(src);
		const destStat = fs.statSync(dest);
		if (srcStat.size !== destStat.size) return true;
		const srcBuf = fs.readFileSync(src);
		const destBuf = fs.readFileSync(dest);
		return !srcBuf.equals(destBuf);
	} catch {
		return true;
	}
}
