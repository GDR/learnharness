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
} from "../src/server/index.ts";
import {
	GET as getVaults,
	POST as postVaults,
} from "../app/api/vaults/route.ts";
import {
	GET as getVaultById,
	PATCH as patchVaultById,
	DELETE as deleteVaultById,
} from "../app/api/vaults/[id]/route.ts";
import { defaultProjectContextPromise } from "../src/server/stores.ts";

test("Milestone B Slice 1 — Vault Registry & REST APIs", async (t) => {
	await defaultProjectContextPromise;
	let tmpDir = "";
	let vaultFolderA = "";
	let vaultFolderB = "";

	function setup() {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-api-vaults-test-"));
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
		setVaultRegistry(null);
		setProjectStore(null);
		try {
			if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup error
		}
	}

	await t.test("GET /api/vaults returns empty list initially and lists registered vaults", async () => {
		setup();
		try {
			const resEmpty = await getVaults(new Request("http://localhost/api/vaults"));
			assert.equal(resEmpty.status, 200);
			const dataEmpty = (await resEmpty.json()) as { vaults: unknown[] };
			assert.deepEqual(dataEmpty.vaults, []);

			// Register two vaults
			await postVaults(
				new Request("http://localhost/api/vaults", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						displayName: "Personal Notes",
						path: vaultFolderA,
					}),
				}),
			);

			await postVaults(
				new Request("http://localhost/api/vaults", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						displayName: "Work Wiki",
						path: vaultFolderB,
					}),
				}),
			);

			const res = await getVaults(new Request("http://localhost/api/vaults"));
			assert.equal(res.status, 200);
			const data = (await res.json()) as {
				vaults: Array<{ id: string; displayName: string; bindings: Array<{ rootPath: string }> }>;
			};
			assert.equal(data.vaults.length, 2);
			assert.equal(data.vaults[0]!.displayName, "Personal Notes");
			assert.equal(data.vaults[0]!.bindings[0]!.rootPath, path.resolve(vaultFolderA));
			assert.equal(data.vaults[1]!.displayName, "Work Wiki");
		} finally {
			teardown();
		}
	});

	await t.test("POST /api/vaults creates vault via shorthand path or explicit bindings", async () => {
		setup();
		try {
			// Shorthand rootPath
			const resShort = await postVaults(
				new Request("http://localhost/api/vaults", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						displayName: "Shorthand Vault",
						rootPath: vaultFolderA,
					}),
				}),
			);
			assert.equal(resShort.status, 201);
			const dataShort = (await resShort.json()) as { vault: { id: string; bindings: Array<{ deviceId: string; status: string }> } };
			assert.ok(dataShort.vault.id.startsWith("vault_"));
			assert.equal(dataShort.vault.bindings[0]!.deviceId, "local");
			assert.equal(dataShort.vault.bindings[0]!.status, "available");

			// Explicit bindings with custom ID
			const resExplicit = await postVaults(
				new Request("http://localhost/api/vaults", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						id: "vault_custom_1",
						displayName: "Explicit Vault",
						bindings: [
							{ deviceId: "macbook", rootPath: vaultFolderB, status: "available" },
							{ deviceId: "linux-server", rootPath: "/mnt/storage/vault", status: "unavailable" },
						],
					}),
				}),
			);
			assert.equal(resExplicit.status, 201);
			const dataExplicit = (await resExplicit.json()) as { vault: { id: string; bindings: Array<{ deviceId: string; status: string }> } };
			assert.equal(dataExplicit.vault.id, "vault_custom_1");
			assert.equal(dataExplicit.vault.bindings.length, 2);
			assert.equal(dataExplicit.vault.bindings[1]!.deviceId, "linux-server");
			assert.equal(dataExplicit.vault.bindings[1]!.status, "unavailable");
		} finally {
			teardown();
		}
	});

	await t.test("POST /api/vaults fails fast on validation errors and duplicate IDs", async () => {
		setup();
		try {
			// Invalid body (not object)
			const res1 = await postVaults(
				new Request("http://localhost/api/vaults", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify("not-an-object"),
				}),
			);
			assert.equal(res1.status, 400);

			// Missing displayName
			const res2 = await postVaults(
				new Request("http://localhost/api/vaults", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ path: vaultFolderA }),
				}),
			);
			assert.equal(res2.status, 400);

			// Invalid vaultId format
			const res3 = await postVaults(
				new Request("http://localhost/api/vaults", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ id: "invalid id with spaces!", displayName: "Test", path: vaultFolderA }),
				}),
			);
			assert.equal(res3.status, 400);

			// Missing bindings and path
			const res4 = await postVaults(
				new Request("http://localhost/api/vaults", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ displayName: "Test" }),
				}),
			);
			assert.equal(res4.status, 400);

			// Empty bindings array
			const res5 = await postVaults(
				new Request("http://localhost/api/vaults", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ displayName: "Test", bindings: [] }),
				}),
			);
			assert.equal(res5.status, 400);

			// Duplicate ID conflict (409)
			const res6 = await postVaults(
				new Request("http://localhost/api/vaults", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ id: "vault_unique", displayName: "Unique", path: vaultFolderA }),
				}),
			);
			assert.equal(res6.status, 201);

			const res7 = await postVaults(
				new Request("http://localhost/api/vaults", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ id: "vault_unique", displayName: "Unique Dup", path: vaultFolderB }),
				}),
			);
			assert.equal(res7.status, 409);
		} finally {
			teardown();
		}
	});

	await t.test("GET /api/vaults/:id retrieves existing vault and handles 400/404", async () => {
		setup();
		try {
			await postVaults(
				new Request("http://localhost/api/vaults", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ id: "v_alpha", displayName: "Alpha", path: vaultFolderA }),
				}),
			);

			// Successful GET
			const resFound = await getVaultById(new Request("http://localhost/api/vaults/v_alpha"), {
				params: Promise.resolve({ id: "v_alpha" }),
			});
			assert.equal(resFound.status, 200);
			const data = (await resFound.json()) as { vault: { id: string; displayName: string } };
			assert.equal(data.vault.displayName, "Alpha");

			// 404 Not Found
			const resMissing = await getVaultById(new Request("http://localhost/api/vaults/v_nonexistent"), {
				params: Promise.resolve({ id: "v_nonexistent" }),
			});
			assert.equal(resMissing.status, 404);

			// 400 Bad Request on invalid ID
			const resInvalid = await getVaultById(new Request("http://localhost/api/vaults/invalid!id"), {
				params: Promise.resolve({ id: "invalid!id" }),
			});
			assert.equal(resInvalid.status, 400);
		} finally {
			teardown();
		}
	});

	await t.test("PATCH /api/vaults/:id updates displayName, bindings, and status shortcut", async () => {
		setup();
		try {
			await postVaults(
				new Request("http://localhost/api/vaults", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ id: "v_patch", displayName: "Initial Name", path: vaultFolderA }),
				}),
			);

			// 1. Update displayName
			const res1 = await patchVaultById(
				new Request("http://localhost/api/vaults/v_patch", {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ displayName: "Updated Name" }),
				}),
				{ params: Promise.resolve({ id: "v_patch" }) },
			);
			assert.equal(res1.status, 200);
			const data1 = (await res1.json()) as { vault: { displayName: string } };
			assert.equal(data1.vault.displayName, "Updated Name");

			// 2. Update status shortcut to "unavailable"
			const res2 = await patchVaultById(
				new Request("http://localhost/api/vaults/v_patch", {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ status: "unavailable" }),
				}),
				{ params: Promise.resolve({ id: "v_patch" }) },
			);
			assert.equal(res2.status, 200);
			const data2 = (await res2.json()) as { vault: { bindings: Array<{ status: string }> } };
			assert.equal(data2.vault.bindings[0]!.status, "unavailable");

			// 3. Upsert a second binding
			const res3 = await patchVaultById(
				new Request("http://localhost/api/vaults/v_patch", {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						binding: { deviceId: "secondary-laptop", rootPath: vaultFolderB, status: "available" },
					}),
				}),
				{ params: Promise.resolve({ id: "v_patch" }) },
			);
			assert.equal(res3.status, 200);
			const data3 = (await res3.json()) as { vault: { bindings: Array<{ deviceId: string; status: string }> } };
			assert.equal(data3.vault.bindings.length, 2);
			assert.equal(data3.vault.bindings[1]!.deviceId, "secondary-laptop");

			// 4. Validation error on empty displayName
			const res4 = await patchVaultById(
				new Request("http://localhost/api/vaults/v_patch", {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ displayName: "  " }),
				}),
				{ params: Promise.resolve({ id: "v_patch" }) },
			);
			assert.equal(res4.status, 400);

			// 5. 404 on nonexistent vault
			const res5 = await patchVaultById(
				new Request("http://localhost/api/vaults/v_missing", {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ displayName: "Does Not Exist" }),
				}),
				{ params: Promise.resolve({ id: "v_missing" }) },
			);
			assert.equal(res5.status, 404);
		} finally {
			teardown();
		}
	});

	await t.test("DELETE /api/vaults/:id enforces attached source safety (409 Conflict vs force=true)", async () => {
		setup();
		try {
			// Register vault
			await postVaults(
				new Request("http://localhost/api/vaults", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ id: "v_attached", displayName: "Attached Vault", path: vaultFolderA }),
				}),
			);

			// Create a project and attach a source pointing to this vault
			const pStore = createProjectStore(tmpDir);
			const project = await pStore.createProject({ id: "proj_safety", name: "Safety Project" });
			const context = await resolveProjectContext("proj_safety", { dataDir: tmpDir });
			await context.sources.addSource({
				projectId: project.id,
				vaultId: "v_attached",
				include: ["**/*.md"],
				exclude: [".obsidian/**"],
				recursive: true,
				enabled: true,
				syncMode: "manual",
				deletionPolicy: "deactivate",
			});

			// Attempt to delete vault without force -> 409 Conflict
			const resBlocked = await deleteVaultById(
				new Request("http://localhost/api/vaults/v_attached", { method: "DELETE" }),
				{ params: Promise.resolve({ id: "v_attached" }) },
			);
			assert.equal(resBlocked.status, 409);
			const dataBlocked = (await resBlocked.json()) as {
				error: string;
				attachedProjects: Array<{ projectId: string; projectName: string }>;
			};
			assert.ok(dataBlocked.error.includes("currently in use"));
			assert.equal(dataBlocked.attachedProjects.length, 1);
			assert.equal(dataBlocked.attachedProjects[0]!.projectId, "proj_safety");

			// Confirm vault was NOT deleted
			const resStillExists = await getVaultById(
				new Request("http://localhost/api/vaults/v_attached"),
				{ params: Promise.resolve({ id: "v_attached" }) },
			);
			assert.equal(resStillExists.status, 200);

			// Now delete with ?force=true
			const resForced = await deleteVaultById(
				new Request("http://localhost/api/vaults/v_attached?force=true", { method: "DELETE" }),
				{ params: Promise.resolve({ id: "v_attached" }) },
			);
			assert.equal(resForced.status, 200);
			const dataForced = (await resForced.json()) as { ok: boolean; deletedVaultId: string; detachedCount: number };
			assert.equal(dataForced.ok, true);
			assert.equal(dataForced.deletedVaultId, "v_attached");
			assert.equal(dataForced.detachedCount, 1);

			// Confirm vault is now 404
			const resDeleted = await getVaultById(
				new Request("http://localhost/api/vaults/v_attached"),
				{ params: Promise.resolve({ id: "v_attached" }) },
			);
			assert.equal(resDeleted.status, 404);

			// Confirm source was detached from the project
			const remainingSources = await context.sources.listSources("proj_safety");
			assert.equal(remainingSources.length, 0);
		} finally {
			teardown();
		}
	});

	await t.test("Disconnected vault handling: availability probing marks missing directories as unavailable", async () => {
		setup();
		try {
			const missingFolder = path.join(tmpDir, "missing_vault_directory");

			// Register vault with an existing folder
			await postVaults(
				new Request("http://localhost/api/vaults", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						id: "v_disconnect",
						displayName: "Disconnection Vault",
						bindings: [{ deviceId: "local", rootPath: missingFolder, status: "available" }],
					}),
				}),
			);

			// Call GET /api/vaults?check=true to refresh availability from disk
			const resCheck = await getVaults(new Request("http://localhost/api/vaults?check=true"));
			assert.equal(resCheck.status, 200);
			const dataCheck = (await resCheck.json()) as {
				vaults: Array<{ id: string; bindings: Array<{ status: string }> }>;
			};
			const vault = dataCheck.vaults.find((v) => v.id === "v_disconnect");
			assert.ok(vault);
			// Directory does not exist, so status should be refreshed to "unavailable"
			assert.equal(vault.bindings[0]!.status, "unavailable");

			// Now create the directory on disk and call GET /api/vaults/:id?check=true
			fs.mkdirSync(missingFolder, { recursive: true });
			const resReconnected = await getVaultById(
				new Request("http://localhost/api/vaults/v_disconnect?check=true"),
				{ params: Promise.resolve({ id: "v_disconnect" }) },
			);
			assert.equal(resReconnected.status, 200);
			const dataReconnected = (await resReconnected.json()) as {
				vault: { bindings: Array<{ status: string }> };
			};
			assert.equal(dataReconnected.vault.bindings[0]!.status, "available");
		} finally {
			teardown();
		}
	});
});
