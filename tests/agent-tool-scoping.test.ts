/**
 * Tests for Milestone A Slice 6: Agent Tool Scoping.
 *
 * Verifies Core Invariant 8:
 * "Background source ingestion is strictly read-only and never modifies Obsidian notes;
 *  existing agent write/edit tools are scoped to the active project's attached sources."
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import {
	resolveAndValidateObsidianPath,
	normalizeSourceScopes,
	type AttachedSourceScope,
} from "../src/agent/tools/fs-shared.ts";
import { writeTool } from "../src/agent/tools/write.ts";
import { editTool } from "../src/agent/tools/edit.ts";
import {
	resolveProjectSourceScopes,
	resolveActiveProjectSourceScopes,
	resolveActiveProjectEffectiveScopes,
	createProjectStore,
	resolveProjectContext,
	clearProjectContextCache,
} from "../src/server/projects.ts";
import { createVaultRegistry } from "../src/store/vaults.ts";
import { DEFAULT_PROJECT_ID } from "../src/core/contracts/project.ts";

describe("Milestone A Slice 6 — Agent Tool Scoping (Core Invariant 8)", () => {
	let tempBase: string;
	let vaultA: string;
	let vaultB: string;
	let outsideDir: string;

	before(async () => {
		tempBase = await fs.mkdtemp(path.join(os.tmpdir(), "lh-agent-scoping-test-"));
		vaultA = path.join(tempBase, "vault-a");
		vaultB = path.join(tempBase, "vault-b");
		outsideDir = path.join(tempBase, "outside");

		await fs.mkdir(vaultA, { recursive: true });
		await fs.mkdir(vaultB, { recursive: true });
		await fs.mkdir(outsideDir, { recursive: true });
	});

	after(async () => {
		if (tempBase) {
			await fs.rm(tempBase, { recursive: true, force: true });
		}
	});

	describe("normalizeSourceScopes", () => {
		it("normalizes empty or undefined input to empty array", () => {
			assert.deepEqual(normalizeSourceScopes(undefined), []);
			assert.deepEqual(normalizeSourceScopes([]), []);
			assert.deepEqual(normalizeSourceScopes({}), []);
		});

		it("normalizes string array to default recursive, enabled AttachedSourceScope", () => {
			const res = normalizeSourceScopes([vaultA]);
			assert.equal(res.length, 1);
			assert.equal(res[0]?.rootPath, vaultA);
			assert.equal(res[0]?.recursive, true);
			assert.equal(res[0]?.enabled, true);
			assert.deepEqual(res[0]?.include, ["**/*"]);
			assert.deepEqual(res[0]?.exclude, []);
		});

		it("normalizes AttachedSourceScope array with custom include, exclude, and options", () => {
			const scopes: AttachedSourceScope[] = [
				{
					rootPath: vaultA,
					include: ["Math/**"],
					exclude: ["Math/private/**"],
					recursive: false,
					enabled: false,
					sourceId: "src_1",
					vaultId: "vault_1",
				},
			];
			const res = normalizeSourceScopes(scopes);
			assert.equal(res.length, 1);
			assert.equal(res[0]?.rootPath, vaultA);
			assert.deepEqual(res[0]?.include, ["Math/**"]);
			assert.deepEqual(res[0]?.exclude, ["Math/private/**"]);
			assert.equal(res[0]?.recursive, false);
			assert.equal(res[0]?.enabled, false);
			assert.equal(res[0]?.sourceId, "src_1");
		});

		it("merges ProjectToolScopingOptions containing both attachedSources and obsidianFolders", () => {
			const res = normalizeSourceScopes({
				attachedSources: [{ rootPath: vaultA, include: ["notes/**"] }],
				obsidianFolders: [vaultB],
			});
			assert.equal(res.length, 2);
			assert.equal(res[0]?.rootPath, vaultA);
			assert.deepEqual(res[0]?.include, ["notes/**"]);
			assert.equal(res[1]?.rootPath, vaultB);
			assert.deepEqual(res[1]?.include, ["**/*"]);
		});
	});

	describe("resolveAndValidateObsidianPath with AttachedSourceScope", () => {
		it("permits paths matching source include glob patterns", async () => {
			const scope: AttachedSourceScope = {
				rootPath: vaultA,
				include: ["notes/**", "wiki/*.md"],
				enabled: true,
			};
			const p1 = await resolveAndValidateObsidianPath(path.join(vaultA, "notes", "calculus.md"), [scope]);
			assert.equal(p1, path.join(vaultA, "notes", "calculus.md"));

			const p2 = await resolveAndValidateObsidianPath(path.join(vaultA, "wiki", "physics.md"), [scope]);
			assert.equal(p2, path.join(vaultA, "wiki", "physics.md"));
		});

		it("rejects paths that do not match source include glob patterns", async () => {
			const scope: AttachedSourceScope = {
				rootPath: vaultA,
				include: ["notes/**"],
				enabled: true,
			};
			await assert.rejects(
				() => resolveAndValidateObsidianPath(path.join(vaultA, "history", "rome.md"), [scope]),
				/does not match any included pattern in the active project source scope/,
			);
		});

		it("rejects paths matching source exclude glob patterns", async () => {
			const scope: AttachedSourceScope = {
				rootPath: vaultA,
				include: ["**/*"],
				exclude: ["private/**", "drafts/*.md"],
				enabled: true,
			};
			await assert.rejects(
				() => resolveAndValidateObsidianPath(path.join(vaultA, "private", "diary.md"), [scope]),
				/is excluded by active project source scope/,
			);
			await assert.rejects(
				() => resolveAndValidateObsidianPath(path.join(vaultA, "drafts", "wip.md"), [scope]),
				/is excluded by active project source scope/,
			);
		});

		it("rejects nested paths when source is non-recursive", async () => {
			const scope: AttachedSourceScope = {
				rootPath: vaultA,
				recursive: false,
				enabled: true,
			};
			// Root file is permitted
			const rootFile = await resolveAndValidateObsidianPath(path.join(vaultA, "root.md"), [scope]);
			assert.equal(rootFile, path.join(vaultA, "root.md"));

			// Nested file in subfolder is rejected
			await assert.rejects(
				() => resolveAndValidateObsidianPath(path.join(vaultA, "sub", "nested.md"), [scope]),
				/is in a subfolder, but the attached project source is non-recursive/,
			);
		});

		it("rejects access to disabled attached sources", async () => {
			const scope: AttachedSourceScope = {
				rootPath: vaultA,
				enabled: false,
				sourceId: "src_archived",
			};
			await assert.rejects(
				() => resolveAndValidateObsidianPath(path.join(vaultA, "note.md"), [scope]),
				/Source 'src_archived' is disabled/,
			);
		});

		it("supports multi-source union: permits write if ANY attached source permits it", async () => {
			const scopes: AttachedSourceScope[] = [
				{
					rootPath: vaultA,
					include: ["math/**"],
					enabled: true,
				},
				{
					rootPath: vaultA,
					include: ["physics/**"],
					enabled: true,
				},
				{
					rootPath: vaultB,
					include: ["chemistry/**"],
					enabled: true,
				},
			];
			// Permitted by scope 1
			const math = await resolveAndValidateObsidianPath(path.join(vaultA, "math", "euler.md"), scopes);
			assert.equal(math, path.join(vaultA, "math", "euler.md"));

			// Permitted by scope 2
			const physics = await resolveAndValidateObsidianPath(path.join(vaultA, "physics", "newton.md"), scopes);
			assert.equal(physics, path.join(vaultA, "physics", "newton.md"));

			// Permitted by scope 3 in vaultB
			const chem = await resolveAndValidateObsidianPath(path.join(vaultB, "chemistry", "periodic.md"), scopes);
			assert.equal(chem, path.join(vaultB, "chemistry", "periodic.md"));

			// Rejected: not covered by any scope
			await assert.rejects(
				() => resolveAndValidateObsidianPath(path.join(vaultA, "biology", "cells.md"), scopes),
				/does not match any included pattern/,
			);
		});
	});

	describe("writeTool with attached sources", () => {
		it("creates markdown file and parent dirs when permitted by attached source", async () => {
			const scope: AttachedSourceScope = {
				rootPath: vaultA,
				include: ["articles/**"],
				enabled: true,
			};
			const targetPath = path.join(vaultA, "articles", "deep", "intro.md");
			const tool = writeTool([scope]);
			const res = await tool.execute!("c_write", {
				path: targetPath,
				content: "# Introduction\n\nDeep article content.",
			});
			const text = (res.content[0] as { type: "text"; text: string }).text;
			assert.ok(text.includes("intro.md"));

			const saved = await fs.readFile(targetPath, "utf-8");
			assert.equal(saved, "# Introduction\n\nDeep article content.");
		});

		it("fails when path is excluded by attached source scope", async () => {
			const scope: AttachedSourceScope = {
				rootPath: vaultA,
				include: ["**/*"],
				exclude: ["secret/**"],
				enabled: true,
			};
			const tool = writeTool([scope]);
			await assert.rejects(
				() => tool.execute!("c_write", { path: path.join(vaultA, "secret", "passwords.md"), content: "123" }),
				/is excluded by active project source scope/,
			);
		});
	});

	describe("editTool with attached sources", () => {
		it("edits file when permitted by attached source", async () => {
			const scope: AttachedSourceScope = {
				rootPath: vaultA,
				include: ["notes/**"],
				enabled: true,
			};
			const filePath = path.join(vaultA, "notes", "editable.md");
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			await fs.writeFile(filePath, "Hello old world!", "utf-8");

			const tool = editTool([scope]);
			const res = await tool.execute!("c_edit", {
				path: filePath,
				oldText: "old world",
				newText: "new universe",
			});
			const text = (res.content[0] as { type: "text"; text: string }).text;
			assert.ok(text.includes("Successfully replaced 1 occurrence"));

			const updated = await fs.readFile(filePath, "utf-8");
			assert.equal(updated, "Hello new universe!");
		});

		it("fails when path is outside attached source include patterns", async () => {
			const scope: AttachedSourceScope = {
				rootPath: vaultA,
				include: ["public/**"],
				enabled: true,
			};
			const filePath = path.join(vaultA, "untracked", "note.md");
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			await fs.writeFile(filePath, "Content", "utf-8");

			const tool = editTool([scope]);
			await assert.rejects(
				() => tool.execute!("c_edit", { path: filePath, oldText: "Content", newText: "Updated" }),
				/does not match any included pattern/,
			);
		});
	});

	describe("Server attached source scope resolution", () => {
		let dataDir: string;

		beforeEach(async () => {
			dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-server-scope-test-"));
			clearProjectContextCache();
		});

		after(async () => {
			if (dataDir) {
				await fs.rm(dataDir, { recursive: true, force: true });
			}
		});

		it("resolves attached source scopes from ProjectStore, SourceStore, and VaultRegistry", async () => {
			const pStore = createProjectStore(dataDir);
			const vRegistry = createVaultRegistry(dataDir);

			// Register vault
			const vault = await vRegistry.registerVault({
				id: "vault_main",
				displayName: "Main Vault",
				kind: "obsidian",
				bindings: [
					{
						deviceId: "device_local",
						rootPath: vaultA,
						status: "available",
					},
				],
			});

			// Create project
			const project = await pStore.createProject({
				id: "proj_custom",
				name: "Custom Project",
			});

			// Attach source to project
			const pCtx = await resolveProjectContext(project.id, { dataDir, projectStore: pStore });
			await pCtx.sources.addSource({
				projectId: project.id,
				vaultId: vault.id,
				include: ["Notes/**"],
				exclude: [".obsidian/**"],
				recursive: true,
				enabled: true,
				syncMode: "manual",
				deletionPolicy: "deactivate",
			});

			const scopes = await resolveProjectSourceScopes(project.id, { dataDir, vaultRegistry: vRegistry });
			assert.equal(scopes.length, 1);
			assert.equal(scopes[0]?.rootPath, vaultA);
			assert.deepEqual(scopes[0]?.include, ["Notes/**"]);
			assert.deepEqual(scopes[0]?.exclude, [".obsidian/**"]);
			assert.equal(scopes[0]?.recursive, true);
			assert.equal(scopes[0]?.enabled, true);
			assert.equal(scopes[0]?.vaultId, "vault_main");
			assert.equal(scopes[0]?.projectId, "proj_custom");
		});

		it("marks scope disabled if vault binding status is unavailable", async () => {
			const pStore = createProjectStore(dataDir);
			const vRegistry = createVaultRegistry(dataDir);

			const vault = await vRegistry.registerVault({
				id: "vault_disconnected",
				displayName: "Disconnected Vault",
				kind: "obsidian",
				bindings: [
					{
						deviceId: "device_remote",
						rootPath: "/Volumes/External/Vault",
						status: "unavailable",
					},
				],
			});

			const project = await pStore.createProject({
				id: "proj_remote",
				name: "Remote Project",
			});

			const pCtx = await resolveProjectContext(project.id, { dataDir, projectStore: pStore });
			await pCtx.sources.addSource({
				projectId: project.id,
				vaultId: vault.id,
				include: ["**/*"],
				exclude: [],
				recursive: true,
				enabled: true,
				syncMode: "manual",
				deletionPolicy: "deactivate",
			});

			const scopes = await resolveProjectSourceScopes(project.id, { dataDir, vaultRegistry: vRegistry });
			assert.equal(scopes.length, 1);
			assert.equal(scopes[0]?.enabled, false, "scope is disabled because binding is unavailable");
		});

		it("resolveActiveProjectEffectiveScopes falls back to obsidianFolders when no sources attached", async () => {
			const pStore = createProjectStore(dataDir);
			await pStore.createProject({
				id: DEFAULT_PROJECT_ID,
				name: "Default Project",
			});

			const scopes = await resolveActiveProjectEffectiveScopes({
				dataDir,
				obsidianFolders: [vaultA, vaultB],
			});
			assert.equal(scopes.length, 2);
			assert.equal(scopes[0]?.rootPath, vaultA);
			assert.equal(scopes[1]?.rootPath, vaultB);
		});

		it("fails fast with 400 on invalid project ID in resolveProjectSourceScopes", async () => {
			await assert.rejects(
				() => resolveProjectSourceScopes("invalid/slash/id", { dataDir }),
				{ name: "InvalidProjectIdError", status: 400 },
			);
		});

		it("fails fast with 404 on missing project in resolveProjectSourceScopes", async () => {
			await assert.rejects(
				() => resolveProjectSourceScopes("proj_nonexistent_123", { dataDir }),
				{ name: "ProjectNotFoundError", status: 404 },
			);
		});
	});
});
