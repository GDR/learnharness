/**
 * Tests for Milestone A Slice 3: Idempotent, Restart-Safe Legacy Migration Engine
 * & Global VaultRegistry.
 */

import { describe, test, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DEFAULT_PROJECT_ID } from "../src/core/contracts/project.ts";
import { createProjectStore } from "../src/store/projects.ts";
import { createVaultRegistry } from "../src/store/vaults.ts";
import { createSourceStore } from "../src/store/sources.ts";
import {
	runLegacyMigration,
	readMigrationCheckpoint,
	hasLegacyData,
	getMigrationCheckpointPath,
} from "../src/server/migration/legacy-migration.ts";

describe("Milestone A Slice 3: VaultRegistry & Legacy Migration Engine", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-migration-test-"));
	});

	afterEach(() => {
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	});

	describe("VaultRegistry", () => {
		it("initializes empty and allows registering vaults and device bindings", async () => {
			const registry = createVaultRegistry(tempDir);
			assert.deepEqual(await registry.listVaults(), []);

			const vaultPath = path.join(tempDir, "sample-vault");
			fs.mkdirSync(vaultPath, { recursive: true });

			const created = await registry.registerVault({
				displayName: "Sample Vault",
				kind: "obsidian",
				bindings: [
					{
						deviceId: "local",
						rootPath: vaultPath,
						status: "available",
					},
				],
			});

			assert.ok(created.id.startsWith("vault_"));
			assert.equal(created.displayName, "Sample Vault");
			assert.equal(created.bindings.length, 1);
			assert.equal(created.bindings[0]?.status, "available");

			const retrieved = await registry.getVault(created.id);
			assert.deepEqual(retrieved, created);

			// Update binding
			const updated = await registry.updateBinding(created.id, {
				deviceId: "local",
				rootPath: vaultPath,
				status: "unavailable",
			});
			assert.equal(updated.bindings[0]?.status, "unavailable");

			// Add secondary device binding
			const withSecondBinding = await registry.updateBinding(created.id, {
				deviceId: "laptop-2",
				rootPath: "/Users/alice/Notes",
				status: "available",
			});
			assert.equal(withSecondBinding.bindings.length, 2);

			// Delete vault
			const deleted = await registry.deleteVault!(created.id);
			assert.equal(deleted, true);
			assert.equal(await registry.getVault(created.id), null);
			assert.equal(await registry.deleteVault!(created.id), false);
		});
	});

	describe("hasLegacyData detection", () => {
		it("returns false for fresh empty directory", () => {
			assert.equal(hasLegacyData(tempDir), false);
		});

		it("returns true when legacy chat files exist", () => {
			const chatsDir = path.join(tempDir, "chats");
			fs.mkdirSync(chatsDir, { recursive: true });
			fs.writeFileSync(path.join(chatsDir, "chat_1.json"), "{}");
			assert.equal(hasLegacyData(tempDir), true);
		});

		it("returns true when legacy obsidianFolders exist in settings.json", () => {
			fs.writeFileSync(
				path.join(tempDir, "settings.json"),
				JSON.stringify({ agent: { obsidianFolders: ["/tmp/vault"] } }),
			);
			assert.equal(hasLegacyData(tempDir), true);
		});
	});

	describe("runLegacyMigration", () => {
		it("handles fresh install with zero legacy data cleanly", async () => {
			const result = await runLegacyMigration({ dataDir: tempDir });
			assert.equal(result.migrated, true);
			assert.equal(result.checkpoint.status, "completed");
			assert.equal(result.checkpoint.migratedCounts.chats, 0);

			// Verifies default project was created
			const pStore = createProjectStore(tempDir);
			const proj = await pStore.getProject(DEFAULT_PROJECT_ID);
			assert.ok(proj);
			assert.equal(proj.id, DEFAULT_PROJECT_ID);
			assert.equal(proj.name, "Default Project");
			assert.equal(await pStore.getActiveProjectId(), DEFAULT_PROJECT_ID);

			// Subsequent run is a no-op
			const secondResult = await runLegacyMigration({ dataDir: tempDir });
			assert.equal(secondResult.migrated, false);
			assert.equal(secondResult.checkpoint.status, "completed");
		});

		it("migrates legacy chats, graph, jobs, practice, and obsidianFolders to proj_default", async () => {
			// Populate simulated legacy data
			const legacyChatsDir = path.join(tempDir, "chats");
			const legacyGraphDir = path.join(tempDir, "graph");
			const legacyJobsDir = path.join(tempDir, "jobs");
			const legacyPracticeDir = path.join(tempDir, "practice");
			const legacyVaultDir = path.join(tempDir, "notes-vault");

			fs.mkdirSync(legacyChatsDir, { recursive: true });
			fs.mkdirSync(legacyGraphDir, { recursive: true });
			fs.mkdirSync(legacyJobsDir, { recursive: true });
			fs.mkdirSync(legacyPracticeDir, { recursive: true });
			fs.mkdirSync(legacyVaultDir, { recursive: true });

			fs.writeFileSync(path.join(legacyChatsDir, "c1.json"), JSON.stringify({ id: "c1", title: "Chat 1" }));
			fs.writeFileSync(path.join(legacyChatsDir, "c2.json"), JSON.stringify({ id: "c2", title: "Chat 2" }));
			fs.writeFileSync(path.join(legacyGraphDir, "nodes.jsonl"), '{"id":"n1"}\n');
			fs.writeFileSync(path.join(legacyGraphDir, "chains.jsonl"), '{"id":"ch1"}\n');
			fs.writeFileSync(path.join(legacyGraphDir, "format.json"), '{"version":1}\n');
			fs.writeFileSync(path.join(legacyJobsDir, "job1.json"), JSON.stringify({ id: "job1" }));
			fs.writeFileSync(path.join(legacyPracticeDir, "p1.json"), JSON.stringify({ id: "p1" }));

			fs.writeFileSync(
				path.join(tempDir, "settings.json"),
				JSON.stringify({ agent: { obsidianFolders: [legacyVaultDir] } }),
			);

			// Run migration
			const result = await runLegacyMigration({ dataDir: tempDir });
			assert.equal(result.migrated, true);
			assert.equal(result.checkpoint.status, "completed");
			assert.equal(result.checkpoint.migratedCounts.chats, 2);
			assert.equal(result.checkpoint.migratedCounts.graphFiles, 3);
			assert.equal(result.checkpoint.migratedCounts.jobs, 1);
			assert.equal(result.checkpoint.migratedCounts.practice, 1);
			assert.equal(result.checkpoint.migratedCounts.vaults, 1);
			assert.equal(result.checkpoint.migratedCounts.sources, 1);

			// Verify destination files exist in projects/proj_default/
			const projDir = path.join(tempDir, "projects", DEFAULT_PROJECT_ID);
			assert.ok(fs.existsSync(path.join(projDir, "chats", "c1.json")));
			assert.ok(fs.existsSync(path.join(projDir, "chats", "c2.json")));
			assert.ok(fs.existsSync(path.join(projDir, "graph", "nodes.jsonl")));
			assert.ok(fs.existsSync(path.join(projDir, "graph", "chains.jsonl")));
			assert.ok(fs.existsSync(path.join(projDir, "jobs", "job1.json")));
			assert.ok(fs.existsSync(path.join(projDir, "practice", "p1.json")));

			// Verify vault was registered globally
			const vRegistry = createVaultRegistry(tempDir);
			const vaults = await vRegistry.listVaults();
			assert.equal(vaults.length, 1);
			assert.equal(vaults[0]?.displayName, "notes-vault");
			assert.equal(vaults[0]?.bindings[0]?.rootPath, path.resolve(legacyVaultDir));
			assert.equal(vaults[0]?.bindings[0]?.status, "available");

			// Verify ProjectSource was registered in proj_default
			const sourceStore = createSourceStore(path.join(projDir, "sources"));
			const sources = await sourceStore.listSources(DEFAULT_PROJECT_ID);
			assert.equal(sources.length, 1);
			assert.equal(sources[0]?.vaultId, vaults[0]?.id);
			assert.equal(sources[0]?.projectId, DEFAULT_PROJECT_ID);

			// Verify migration checkpoint record
			const checkpoint = await readMigrationCheckpoint(tempDir);
			assert.ok(checkpoint);
			assert.equal(checkpoint.status, "completed");
			assert.ok(checkpoint.completedAt);
		});

		it("resumes safely from an interrupted in_progress checkpoint without duplicating records", async () => {
			const checkpointPath = getMigrationCheckpointPath(tempDir);
			fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });

			// Simulate crash during migration
			fs.writeFileSync(
				checkpointPath,
				JSON.stringify({
					status: "in_progress",
					startedAt: new Date(Date.now() - 10000).toISOString(),
					migratedCounts: {
						chats: 1,
						graphFiles: 0,
						jobs: 0,
						practice: 0,
						vaults: 0,
						sources: 0,
					},
				}),
			);

			const legacyChatsDir = path.join(tempDir, "chats");
			fs.mkdirSync(legacyChatsDir, { recursive: true });
			fs.writeFileSync(path.join(legacyChatsDir, "chat_interrupted.json"), JSON.stringify({ id: "ci" }));

			// Resume
			const result = await runLegacyMigration({ dataDir: tempDir });
			assert.equal(result.migrated, true);
			assert.equal(result.checkpoint.status, "completed");

			const projDir = path.join(tempDir, "projects", DEFAULT_PROJECT_ID);
			assert.ok(fs.existsSync(path.join(projDir, "chats", "chat_interrupted.json")));

			// Re-running again is immediately idempotent
			const replay = await runLegacyMigration({ dataDir: tempDir });
			assert.equal(replay.migrated, false);
			assert.equal(replay.checkpoint.status, "completed");
		});
	});
});
