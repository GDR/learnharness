import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
	createVaultRegistry,
	setVaultRegistry,
	createProjectStore,
	setProjectStore,
	resolveProjectContext,
	clearProjectContextCache,
} from "../src/server/index.ts";
import {
	DEFAULT_SOURCE_EXCLUDE,
	DEFAULT_SOURCE_INCLUDE,
	sourceIdRegex,
} from "../src/core/contracts/project.ts";
import {
	GET as getSources,
	POST as postSources,
} from "../app/api/projects/[id]/sources/route.ts";
import {
	GET as getSourceById,
	PATCH as patchSourceById,
	DELETE as deleteSourceById,
} from "../app/api/projects/[id]/sources/[sourceId]/route.ts";
import { defaultProjectContextPromise } from "../src/server/stores.ts";

test("Milestone B Slice 2 — ProjectSourceStore & REST APIs", async (t) => {
	await defaultProjectContextPromise;
	let tmpDir = "";
	let vaultFolderA = "";
	let vaultFolderB = "";

	function setup() {
		clearProjectContextCache();
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-api-sources-test-"));
		vaultFolderA = path.join(tmpDir, "vault_a");
		vaultFolderB = path.join(tmpDir, "vault_b");
		fs.mkdirSync(vaultFolderA, { recursive: true });
		fs.mkdirSync(vaultFolderB, { recursive: true });

		const vRegistry = createVaultRegistry(tmpDir);
		setVaultRegistry(vRegistry);

		const pStore = createProjectStore(tmpDir);
		setProjectStore(pStore);
	}

	function teardown() {
		clearProjectContextCache();
		setVaultRegistry(null);
		setProjectStore(null);
		try {
			if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup error
		}
	}

	await t.test("Full CRUD lifecycle: create, list, get, patch, delete", async () => {
		setup();
		try {
			const pStore = createProjectStore(tmpDir);
			const project = await pStore.createProject({ id: "proj_crud", name: "CRUD Project" });

			const vRegistry = createVaultRegistry(tmpDir);
			const vault = await vRegistry.registerVault({
				id: "vault_crud",
				displayName: "CRUD Vault",
				kind: "obsidian",
				bindings: [{ deviceId: "local", rootPath: vaultFolderA, status: "available" }],
			});

			// 1. GET initially returns empty sources array
			const resEmpty = await getSources(
				new Request("http://localhost/api/projects/proj_crud/sources"),
				{ params: Promise.resolve({ id: "proj_crud" }) },
			);
			assert.equal(resEmpty.status, 200);
			const dataEmpty = (await resEmpty.json()) as { sources: unknown[] };
			assert.deepEqual(dataEmpty.sources, []);

			// 2. POST creates source with defaults
			const resPost = await postSources(
				new Request("http://localhost/api/projects/proj_crud/sources", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ vaultId: vault.id }),
				}),
				{ params: Promise.resolve({ id: "proj_crud" }) },
			);
			assert.equal(resPost.status, 201);
			const dataPost = (await resPost.json()) as {
				source: {
					id: string;
					projectId: string;
					vaultId: string;
					include: string[];
					exclude: string[];
					recursive: boolean;
					enabled: boolean;
					syncMode: string;
					deletionPolicy: string;
					createdAt: string;
				};
			};
			const createdSource = dataPost.source;
			assert.ok(sourceIdRegex.test(createdSource.id), `ID "${createdSource.id}" should match sourceIdRegex`);
			assert.equal(createdSource.projectId, "proj_crud");
			assert.equal(createdSource.vaultId, "vault_crud");
			assert.deepEqual(createdSource.include, [...DEFAULT_SOURCE_INCLUDE]);
			assert.deepEqual(createdSource.exclude, [...DEFAULT_SOURCE_EXCLUDE]);
			assert.equal(createdSource.recursive, true);
			assert.equal(createdSource.enabled, true);
			assert.equal(createdSource.syncMode, "manual");
			assert.equal(createdSource.deletionPolicy, "deactivate");
			assert.ok(Date.parse(createdSource.createdAt) > 0);

			// 3. GET list contains the created source
			const resList = await getSources(
				new Request("http://localhost/api/projects/proj_crud/sources"),
				{ params: Promise.resolve({ id: "proj_crud" }) },
			);
			assert.equal(resList.status, 200);
			const dataList = (await resList.json()) as { sources: Array<{ id: string }> };
			assert.equal(dataList.sources.length, 1);
			assert.equal(dataList.sources[0]!.id, createdSource.id);

			// 4. GET by ID retrieves the created source
			const resGet = await getSourceById(
				new Request(`http://localhost/api/projects/proj_crud/sources/${createdSource.id}`),
				{ params: Promise.resolve({ id: "proj_crud", sourceId: createdSource.id }) },
			);
			assert.equal(resGet.status, 200);
			const dataGet = (await resGet.json()) as { source: { id: string; vaultId: string } };
			assert.equal(dataGet.source.id, createdSource.id);
			assert.equal(dataGet.source.vaultId, "vault_crud");

			// 5. PATCH updates mutable fields
			const resPatch = await patchSourceById(
				new Request(`http://localhost/api/projects/proj_crud/sources/${createdSource.id}`, {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						include: ["notes/**/*.md"],
						exclude: ["notes/archive/**"],
						recursive: false,
						enabled: false,
						syncMode: "automatic",
						deletionPolicy: "retain",
					}),
				}),
				{ params: Promise.resolve({ id: "proj_crud", sourceId: createdSource.id }) },
			);
			assert.equal(resPatch.status, 200);
			const dataPatch = (await resPatch.json()) as {
				source: {
					include: string[];
					exclude: string[];
					recursive: boolean;
					enabled: boolean;
					syncMode: string;
					deletionPolicy: string;
				};
			};
			assert.deepEqual(dataPatch.source.include, ["notes/**/*.md"]);
			assert.deepEqual(dataPatch.source.exclude, ["notes/archive/**"]);
			assert.equal(dataPatch.source.recursive, false);
			assert.equal(dataPatch.source.enabled, false);
			assert.equal(dataPatch.source.syncMode, "automatic");
			assert.equal(dataPatch.source.deletionPolicy, "retain");

			// Verify changes persisted via GET
			const resGetUpdated = await getSourceById(
				new Request(`http://localhost/api/projects/proj_crud/sources/${createdSource.id}`),
				{ params: Promise.resolve({ id: "proj_crud", sourceId: createdSource.id }) },
			);
			assert.equal(resGetUpdated.status, 200);
			const dataGetUpdated = (await resGetUpdated.json()) as { source: { enabled: boolean; syncMode: string } };
			assert.equal(dataGetUpdated.source.enabled, false);
			assert.equal(dataGetUpdated.source.syncMode, "automatic");

			// 6. DELETE removes the source
			const resDelete = await deleteSourceById(
				new Request(`http://localhost/api/projects/proj_crud/sources/${createdSource.id}`, {
					method: "DELETE",
				}),
				{ params: Promise.resolve({ id: "proj_crud", sourceId: createdSource.id }) },
			);
			assert.equal(resDelete.status, 200);
			const dataDelete = (await resDelete.json()) as { success: boolean; deletedSourceId: string };
			assert.equal(dataDelete.success, true);
			assert.equal(dataDelete.deletedSourceId, createdSource.id);

			// 7. Verify source is gone (GET -> 404, list -> empty)
			const resGetGone = await getSourceById(
				new Request(`http://localhost/api/projects/proj_crud/sources/${createdSource.id}`),
				{ params: Promise.resolve({ id: "proj_crud", sourceId: createdSource.id }) },
			);
			assert.equal(resGetGone.status, 404);

			const resListGone = await getSources(
				new Request("http://localhost/api/projects/proj_crud/sources"),
				{ params: Promise.resolve({ id: "proj_crud" }) },
			);
			assert.equal(resListGone.status, 200);
			const dataListGone = (await resListGone.json()) as { sources: unknown[] };
			assert.deepEqual(dataListGone.sources, []);
		} finally {
			teardown();
		}
	});

	await t.test("Default include and exclude globs are applied when omitted or empty", async () => {
		setup();
		try {
			const pStore = createProjectStore(tmpDir);
			await pStore.createProject({ id: "proj_defaults", name: "Defaults Project" });

			const vRegistry = createVaultRegistry(tmpDir);
			await vRegistry.registerVault({
				id: "v_def",
				displayName: "Defaults Vault",
				kind: "obsidian",
				bindings: [{ deviceId: "local", rootPath: vaultFolderA, status: "available" }],
			});

			// Case 1: include and exclude completely omitted
			const res1 = await postSources(
				new Request("http://localhost/api/projects/proj_defaults/sources", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ vaultId: "v_def" }),
				}),
				{ params: Promise.resolve({ id: "proj_defaults" }) },
			);
			assert.equal(res1.status, 201);
			const data1 = (await res1.json()) as { source: { include: string[]; exclude: string[] } };
			assert.deepEqual(data1.source.include, [...DEFAULT_SOURCE_INCLUDE]);
			assert.deepEqual(data1.source.exclude, [...DEFAULT_SOURCE_EXCLUDE]);

			// Case 2: include: [] and exclude: [] explicitly passed as empty arrays
			const res2 = await postSources(
				new Request("http://localhost/api/projects/proj_defaults/sources", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ vaultId: "v_def", include: [], exclude: [] }),
				}),
				{ params: Promise.resolve({ id: "proj_defaults" }) },
			);
			assert.equal(res2.status, 201);
			const data2 = (await res2.json()) as { source: { include: string[]; exclude: string[] } };
			assert.deepEqual(data2.source.include, [...DEFAULT_SOURCE_INCLUDE]);
			assert.deepEqual(data2.source.exclude, [...DEFAULT_SOURCE_EXCLUDE]);

			// Case 3: array with only whitespace strings
			const res3 = await postSources(
				new Request("http://localhost/api/projects/proj_defaults/sources", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ vaultId: "v_def", include: ["   ", ""], exclude: ["  "] }),
				}),
				{ params: Promise.resolve({ id: "proj_defaults" }) },
			);
			assert.equal(res3.status, 201);
			const data3 = (await res3.json()) as { source: { include: string[]; exclude: string[] } };
			assert.deepEqual(data3.source.include, [...DEFAULT_SOURCE_INCLUDE]);
			assert.deepEqual(data3.source.exclude, [...DEFAULT_SOURCE_EXCLUDE]);
		} finally {
			teardown();
		}
	});

	await t.test("Glob normalization trims whitespace and eliminates redundant slashes", async () => {
		setup();
		try {
			const pStore = createProjectStore(tmpDir);
			await pStore.createProject({ id: "proj_globs", name: "Globs Project" });

			const vRegistry = createVaultRegistry(tmpDir);
			await vRegistry.registerVault({
				id: "v_globs",
				displayName: "Globs Vault",
				kind: "obsidian",
				bindings: [{ deviceId: "local", rootPath: vaultFolderA, status: "available" }],
			});

			const res = await postSources(
				new Request("http://localhost/api/projects/proj_globs/sources", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						vaultId: "v_globs",
						include: ["  notes//**//*.md  ", "  docs///spec.md  "],
						exclude: ["  .obsidian///cache/**  ", "  .git////**  "],
					}),
				}),
				{ params: Promise.resolve({ id: "proj_globs" }) },
			);
			assert.equal(res.status, 201);
			const data = (await res.json()) as { source: { include: string[]; exclude: string[] } };
			assert.deepEqual(data.source.include, ["notes/**/*.md", "docs/spec.md"]);
			assert.deepEqual(data.source.exclude, [".obsidian/cache/**", ".git/**"]);
		} finally {
			teardown();
		}
	});

	await t.test("Fail-fast HTTP 400 for malformed projectId and sourceId", async () => {
		setup();
		try {
			const pStore = createProjectStore(tmpDir);
			await pStore.createProject({ id: "proj_valid", name: "Valid Project" });

			const invalidProjectIds = ["invalid project id", "proj/slash", "proj@hash", "   "];
			for (const badId of invalidProjectIds) {
				// GET sources
				const resGet = await getSources(
					new Request(`http://localhost/api/projects/${encodeURIComponent(badId)}/sources`),
					{ params: Promise.resolve({ id: badId }) },
				);
				assert.equal(resGet.status, 400);

				// POST source
				const resPost = await postSources(
					new Request(`http://localhost/api/projects/${encodeURIComponent(badId)}/sources`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ vaultId: "vault_1" }),
					}),
					{ params: Promise.resolve({ id: badId }) },
				);
				assert.equal(resPost.status, 400);

				// GET source by ID
				const resGetById = await getSourceById(
					new Request(`http://localhost/api/projects/${encodeURIComponent(badId)}/sources/src_1`),
					{ params: Promise.resolve({ id: badId, sourceId: "src_1" }) },
				);
				assert.equal(resGetById.status, 400);

				// PATCH source by ID
				const resPatch = await patchSourceById(
					new Request(`http://localhost/api/projects/${encodeURIComponent(badId)}/sources/src_1`, {
						method: "PATCH",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ enabled: false }),
					}),
					{ params: Promise.resolve({ id: badId, sourceId: "src_1" }) },
				);
				assert.equal(resPatch.status, 400);

				// DELETE source by ID
				const resDelete = await deleteSourceById(
					new Request(`http://localhost/api/projects/${encodeURIComponent(badId)}/sources/src_1`, {
						method: "DELETE",
					}),
					{ params: Promise.resolve({ id: badId, sourceId: "src_1" }) },
				);
				assert.equal(resDelete.status, 400);
			}

			// Malformed sourceId checks
			const invalidSourceIds = ["invalid source id", "src/slash", "src@at", "   "];
			for (const badSourceId of invalidSourceIds) {
				const resGet = await getSourceById(
					new Request(`http://localhost/api/projects/proj_valid/sources/${encodeURIComponent(badSourceId)}`),
					{ params: Promise.resolve({ id: "proj_valid", sourceId: badSourceId }) },
				);
				assert.equal(resGet.status, 400);

				const resPatch = await patchSourceById(
					new Request(`http://localhost/api/projects/proj_valid/sources/${encodeURIComponent(badSourceId)}`, {
						method: "PATCH",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ enabled: false }),
					}),
					{ params: Promise.resolve({ id: "proj_valid", sourceId: badSourceId }) },
				);
				assert.equal(resPatch.status, 400);

				const resDelete = await deleteSourceById(
					new Request(`http://localhost/api/projects/proj_valid/sources/${encodeURIComponent(badSourceId)}`, {
						method: "DELETE",
					}),
					{ params: Promise.resolve({ id: "proj_valid", sourceId: badSourceId }) },
				);
				assert.equal(resDelete.status, 400);
			}
		} finally {
			teardown();
		}
	});

	await t.test("Fail-fast HTTP 400 for malformed request body schemas", async () => {
		setup();
		try {
			const pStore = createProjectStore(tmpDir);
			await pStore.createProject({ id: "proj_schema", name: "Schema Project" });

			const vRegistry = createVaultRegistry(tmpDir);
			await vRegistry.registerVault({
				id: "vault_schema",
				displayName: "Schema Vault",
				kind: "obsidian",
				bindings: [{ deviceId: "local", rootPath: vaultFolderA, status: "available" }],
			});

			// 1. Invalid JSON / non-object
			const resNonObj = await postSources(
				new Request("http://localhost/api/projects/proj_schema/sources", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify("not-an-object"),
				}),
				{ params: Promise.resolve({ id: "proj_schema" }) },
			);
			assert.equal(resNonObj.status, 400);

			// 2. Missing vaultId
			const resMissingVault = await postSources(
				new Request("http://localhost/api/projects/proj_schema/sources", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ include: ["**/*.md"] }),
				}),
				{ params: Promise.resolve({ id: "proj_schema" }) },
			);
			assert.equal(resMissingVault.status, 400);

			// 3. Malformed vaultId format
			const resBadVaultId = await postSources(
				new Request("http://localhost/api/projects/proj_schema/sources", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ vaultId: "bad vault id with spaces" }),
				}),
				{ params: Promise.resolve({ id: "proj_schema" }) },
			);
			assert.equal(resBadVaultId.status, 400);

			// 4. Invalid types for optional fields in POST
			const badBodies = [
				{ vaultId: "vault_schema", include: "not-an-array" },
				{ vaultId: "vault_schema", exclude: [123, 456] },
				{ vaultId: "vault_schema", recursive: "true" },
				{ vaultId: "vault_schema", enabled: 1 },
				{ vaultId: "vault_schema", syncMode: "instant" },
				{ vaultId: "vault_schema", deletionPolicy: "purge" },
			];
			for (const body of badBodies) {
				const res = await postSources(
					new Request("http://localhost/api/projects/proj_schema/sources", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(body),
					}),
					{ params: Promise.resolve({ id: "proj_schema" }) },
				);
				assert.equal(res.status, 400, `Expected 400 for body: ${JSON.stringify(body)}`);
			}

			// Create a valid source to test PATCH validation
			const resValid = await postSources(
				new Request("http://localhost/api/projects/proj_schema/sources", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ vaultId: "vault_schema" }),
				}),
				{ params: Promise.resolve({ id: "proj_schema" }) },
			);
			assert.equal(resValid.status, 201);
			const { source } = (await resValid.json()) as { source: { id: string } };

			// 5. Invalid types for PATCH body
			const badPatches = [
				"non-object",
				{ include: "string" },
				{ exclude: [true] },
				{ recursive: "yes" },
				{ enabled: "no" },
				{ syncMode: "invalid-sync" },
				{ deletionPolicy: "invalid-policy" },
			];
			for (const patch of badPatches) {
				const res = await patchSourceById(
					new Request(`http://localhost/api/projects/proj_schema/sources/${source.id}`, {
						method: "PATCH",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(patch),
					}),
					{ params: Promise.resolve({ id: "proj_schema", sourceId: source.id }) },
				);
				assert.equal(res.status, 400, `Expected 400 for patch: ${JSON.stringify(patch)}`);
			}
		} finally {
			teardown();
		}
	});

	await t.test("Fail-fast HTTP 404 for unknown projects, unknown vaults, and unknown sources", async () => {
		setup();
		try {
			const pStore = createProjectStore(tmpDir);
			await pStore.createProject({ id: "proj_exists", name: "Exists Project" });

			const vRegistry = createVaultRegistry(tmpDir);
			await vRegistry.registerVault({
				id: "vault_exists",
				displayName: "Exists Vault",
				kind: "obsidian",
				bindings: [{ deviceId: "local", rootPath: vaultFolderA, status: "available" }],
			});

			// 1. Unknown projectId on GET / POST / GET:id / PATCH / DELETE
			const resGetUnknownProj = await getSources(
				new Request("http://localhost/api/projects/proj_nonexistent/sources"),
				{ params: Promise.resolve({ id: "proj_nonexistent" }) },
			);
			assert.equal(resGetUnknownProj.status, 404);

			const resPostUnknownProj = await postSources(
				new Request("http://localhost/api/projects/proj_nonexistent/sources", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ vaultId: "vault_exists" }),
				}),
				{ params: Promise.resolve({ id: "proj_nonexistent" }) },
			);
			assert.equal(resPostUnknownProj.status, 404);

			const resGetByIdUnknownProj = await getSourceById(
				new Request("http://localhost/api/projects/proj_nonexistent/sources/src_1"),
				{ params: Promise.resolve({ id: "proj_nonexistent", sourceId: "src_1" }) },
			);
			assert.equal(resGetByIdUnknownProj.status, 404);

			const resPatchUnknownProj = await patchSourceById(
				new Request("http://localhost/api/projects/proj_nonexistent/sources/src_1", {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ enabled: false }),
				}),
				{ params: Promise.resolve({ id: "proj_nonexistent", sourceId: "src_1" }) },
			);
			assert.equal(resPatchUnknownProj.status, 404);

			const resDeleteUnknownProj = await deleteSourceById(
				new Request("http://localhost/api/projects/proj_nonexistent/sources/src_1", {
					method: "DELETE",
				}),
				{ params: Promise.resolve({ id: "proj_nonexistent", sourceId: "src_1" }) },
			);
			assert.equal(resDeleteUnknownProj.status, 404);

			// 2. Unknown vaultId on POST /api/projects/:id/sources -> 404 VaultNotFoundError
			const resPostUnknownVault = await postSources(
				new Request("http://localhost/api/projects/proj_exists/sources", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ vaultId: "vault_does_not_exist" }),
				}),
				{ params: Promise.resolve({ id: "proj_exists" }) },
			);
			assert.equal(resPostUnknownVault.status, 404);
			const dataUnknownVault = (await resPostUnknownVault.json()) as { error: string };
			assert.ok(dataUnknownVault.error.includes("Vault not found"));

			// 3. Unknown sourceId on existing project
			const resGetUnknownSrc = await getSourceById(
				new Request("http://localhost/api/projects/proj_exists/sources/src_nonexistent"),
				{ params: Promise.resolve({ id: "proj_exists", sourceId: "src_nonexistent" }) },
			);
			assert.equal(resGetUnknownSrc.status, 404);

			const resPatchUnknownSrc = await patchSourceById(
				new Request("http://localhost/api/projects/proj_exists/sources/src_nonexistent", {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ enabled: false }),
				}),
				{ params: Promise.resolve({ id: "proj_exists", sourceId: "src_nonexistent" }) },
			);
			assert.equal(resPatchUnknownSrc.status, 404);

			const resDeleteUnknownSrc = await deleteSourceById(
				new Request("http://localhost/api/projects/proj_exists/sources/src_nonexistent", {
					method: "DELETE",
				}),
				{ params: Promise.resolve({ id: "proj_exists", sourceId: "src_nonexistent" }) },
			);
			assert.equal(resDeleteUnknownSrc.status, 404);
		} finally {
			teardown();
		}
	});

	await t.test("Cross-project isolation: sources cannot be accessed or mutated across projects", async () => {
		setup();
		try {
			const pStore = createProjectStore(tmpDir);
			await pStore.createProject({ id: "proj_alpha", name: "Alpha Project" });
			await pStore.createProject({ id: "proj_beta", name: "Beta Project" });

			const vRegistry = createVaultRegistry(tmpDir);
			await vRegistry.registerVault({
				id: "v_shared",
				displayName: "Shared Vault",
				kind: "obsidian",
				bindings: [{ deviceId: "local", rootPath: vaultFolderA, status: "available" }],
			});

			// Add source to Project Alpha
			const resAlpha = await postSources(
				new Request("http://localhost/api/projects/proj_alpha/sources", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ vaultId: "v_shared" }),
				}),
				{ params: Promise.resolve({ id: "proj_alpha" }) },
			);
			assert.equal(resAlpha.status, 201);
			const { source: sourceAlpha } = (await resAlpha.json()) as { source: { id: string } };

			// Add source to Project Beta pointing to same vault
			const resBeta = await postSources(
				new Request("http://localhost/api/projects/proj_beta/sources", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ vaultId: "v_shared" }),
				}),
				{ params: Promise.resolve({ id: "proj_beta" }) },
			);
			assert.equal(resBeta.status, 201);
			const { source: sourceBeta } = (await resBeta.json()) as { source: { id: string } };

			assert.notEqual(sourceAlpha.id, sourceBeta.id);

			// Attempting to access sourceAlpha via Project Beta yields 404
			const resGetCross = await getSourceById(
				new Request(`http://localhost/api/projects/proj_beta/sources/${sourceAlpha.id}`),
				{ params: Promise.resolve({ id: "proj_beta", sourceId: sourceAlpha.id }) },
			);
			assert.equal(resGetCross.status, 404);

			// Attempting to PATCH sourceAlpha via Project Beta yields 404
			const resPatchCross = await patchSourceById(
				new Request(`http://localhost/api/projects/proj_beta/sources/${sourceAlpha.id}`, {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ enabled: false }),
				}),
				{ params: Promise.resolve({ id: "proj_beta", sourceId: sourceAlpha.id }) },
			);
			assert.equal(resPatchCross.status, 404);

			// Attempting to DELETE sourceAlpha via Project Beta yields 404
			const resDeleteCross = await deleteSourceById(
				new Request(`http://localhost/api/projects/proj_beta/sources/${sourceAlpha.id}`, {
					method: "DELETE",
				}),
				{ params: Promise.resolve({ id: "proj_beta", sourceId: sourceAlpha.id }) },
			);
			assert.equal(resDeleteCross.status, 404);

			// Confirm sourceAlpha is still untouched in Project Alpha
			const resAlphaConfirm = await getSourceById(
				new Request(`http://localhost/api/projects/proj_alpha/sources/${sourceAlpha.id}`),
				{ params: Promise.resolve({ id: "proj_alpha", sourceId: sourceAlpha.id }) },
			);
			assert.equal(resAlphaConfirm.status, 200);

			// Mutating sourceBeta does not affect sourceAlpha
			await patchSourceById(
				new Request(`http://localhost/api/projects/proj_beta/sources/${sourceBeta.id}`, {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ enabled: false }),
				}),
				{ params: Promise.resolve({ id: "proj_beta", sourceId: sourceBeta.id }) },
			);

			const resAlphaCheck = await getSourceById(
				new Request(`http://localhost/api/projects/proj_alpha/sources/${sourceAlpha.id}`),
				{ params: Promise.resolve({ id: "proj_alpha", sourceId: sourceAlpha.id }) },
			);
			const dataAlpha = (await resAlphaCheck.json()) as { source: { enabled: boolean } };
			assert.equal(dataAlpha.source.enabled, true); // Alpha remains enabled
		} finally {
			teardown();
		}
	});

	await t.test("Deleting source removes attached document inventories", async () => {
		setup();
		try {
			const pStore = createProjectStore(tmpDir);
			await pStore.createProject({ id: "proj_docs", name: "Docs Project" });

			const vRegistry = createVaultRegistry(tmpDir);
			await vRegistry.registerVault({
				id: "v_docs",
				displayName: "Docs Vault",
				kind: "obsidian",
				bindings: [{ deviceId: "local", rootPath: vaultFolderA, status: "available" }],
			});

			const res = await postSources(
				new Request("http://localhost/api/projects/proj_docs/sources", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ vaultId: "v_docs" }),
				}),
				{ params: Promise.resolve({ id: "proj_docs" }) },
			);
			assert.equal(res.status, 201);
			const { source } = (await res.json()) as { source: { id: string } };

			const ctx = await resolveProjectContext("proj_docs", { dataDir: tmpDir });
			await ctx.sources.upsertDocument({
				id: "doc_1",
				sourceId: source.id,
				vaultId: "v_docs",
				currentPath: "note.md",
				contentHash: "hash123",
				revisionId: "rev1",
				status: "active",
			});

			const docsBefore = await ctx.sources.listDocuments(source.id);
			assert.equal(docsBefore.length, 1);

			// Delete source via API
			const resDel = await deleteSourceById(
				new Request(`http://localhost/api/projects/proj_docs/sources/${source.id}`, { method: "DELETE" }),
				{ params: Promise.resolve({ id: "proj_docs", sourceId: source.id }) },
			);
			assert.equal(resDel.status, 200);

			// Documents should be purged
			const docsAfter = await ctx.sources.listDocuments(source.id);
			assert.equal(docsAfter.length, 0);
		} finally {
			teardown();
		}
	});
});
