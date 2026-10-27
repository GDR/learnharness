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
	clearProjectContextCache,
	scanSourceDocuments,
	loadSourceInventory,
	VaultUnavailableError,
} from "../src/server/index.ts";
import {
	matchesGlob,
	globToRegex,
	validateScanResult,
	validateSourceDocument,
} from "../src/core/contracts/indexing.ts";
import {
	POST as scanPostRoute,
	GET as scanGetRoute,
} from "../app/api/projects/[id]/sources/[sourceId]/scan/route.ts";

test("Milestone C Slice 1: Document Inventory & Change Scanner", async (t) => {
	let tmpDir = "";
	let vaultFolder = "";

	function setup() {
		clearProjectContextCache();
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-scanner-test-"));
		vaultFolder = path.join(tmpDir, "vault");
		fs.mkdirSync(vaultFolder, { recursive: true });

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

	await t.test("pure glob matching and regex engine", () => {
		// Pattern compilation
		const rx = globToRegex("**/*.md");
		assert.ok(rx.test("note.md"));
		assert.ok(rx.test("deep/folder/note.md"));
		assert.ok(!rx.test("note.txt"));

		// Exclude rules override include rules
		assert.equal(matchesGlob("normal.md"), true);
		assert.equal(matchesGlob(".obsidian/app.json"), false);
		assert.equal(matchesGlob(".obsidian/plugins/test/main.js"), false);
		assert.equal(matchesGlob(".trash/deleted.md"), false);
		assert.equal(matchesGlob(".git/config"), false);
		assert.equal(matchesGlob("node_modules/foo/bar.md"), false);

		// Non-recursive glob
		assert.equal(matchesGlob("root.md", ["*.md"]), true);
		assert.equal(matchesGlob("nested/sub.md", ["*.md"]), false);

		// Exclude globs targeting names with "any" or "dummy.md" do not falsely exclude valid siblings
		assert.equal(matchesGlob("notes/guide.md", ["**/*.md"], ["notes/any"]), true);
		assert.equal(matchesGlob("notes/any/secret.md", ["**/*.md"], ["notes/any"]), false);
		assert.equal(matchesGlob("notes/guide.md", ["**/*.md"], ["*/any"]), true);
		assert.equal(matchesGlob("notes/guide.md", ["**/*.md"], ["notes/dummy.md"]), true);
		assert.equal(matchesGlob("notes/dummy.md", ["**/*.md"], ["notes/dummy.md"]), false);
	});

	await t.test("scans fresh vault, computes SHA-256 hashes and persists inventory", async () => {
		setup();
		try {
			const pStore = createProjectStore(tmpDir);
			await pStore.createProject({ id: "proj_scan_1", name: "Scan Project 1" });

			const vRegistry = createVaultRegistry(tmpDir);
			const vault = await vRegistry.registerVault({
				id: "vault_scan_1",
				displayName: "Scan Vault 1",
				kind: "obsidian",
				bindings: [{ deviceId: "local", rootPath: vaultFolder, status: "available" }],
			});

			// Write markdown files to vault
			fs.writeFileSync(path.join(vaultFolder, "Note1.md"), "# Quantum Computing\nSuperposition basics.");
			fs.mkdirSync(path.join(vaultFolder, "Sub"), { recursive: true });
			fs.writeFileSync(path.join(vaultFolder, "Sub", "Note2.md"), "# Entanglement\nBell state measurement.");
			// Non-markdown file
			fs.writeFileSync(path.join(vaultFolder, "image.png"), "fake binary content");

			// Attach project source
			const { context } = await (await import("../src/server/sources.ts")).resolveProjectSource("proj_scan_1", "src_scan_1").catch(async () => {
				const ctx = await (await import("../src/server/projects.ts")).resolveProjectContext("proj_scan_1", { dataDir: tmpDir });
				const src = await ctx.sources.addSource({
					id: "src_scan_1",
					projectId: "proj_scan_1",
					vaultId: vault.id,
					include: ["**/*.md"],
					exclude: [".obsidian/**", ".trash/**"],
					recursive: true,
				});
				return { context: ctx, source: src };
			});

			const result = await scanSourceDocuments({
				projectId: "proj_scan_1",
				sourceId: "src_scan_1",
				dataDir: tmpDir,
			});

			// Validate with contract schema
			validateScanResult(result);

			assert.equal(result.sourceId, "src_scan_1");
			assert.equal(result.vaultId, vault.id);
			assert.equal(result.scannedCount, 2);
			assert.equal(result.addedCount, 2);
			assert.equal(result.modifiedCount, 0);
			assert.equal(result.unchangedCount, 0);
			assert.equal(result.removedCount, 0);
			assert.equal(result.documents.length, 2);

			const doc1 = result.documents.find((d) => d.currentPath === "Note1.md");
			assert.ok(doc1);
			validateSourceDocument(doc1);
			assert.equal(doc1.projectId, "proj_scan_1");
			assert.equal(doc1.sourceId, "src_scan_1");
			assert.equal(doc1.vaultId, vault.id);
			assert.equal(doc1.status, "active");
			assert.match(doc1.contentHash, /^[0-9a-f]{64}$/);
			assert.match(doc1.revisionId, /^rev_[0-9a-f]{12}$/);
			assert.match(doc1.id, /^doc_[0-9a-f]{16}$/);

			const doc2 = result.documents.find((d) => d.currentPath === "Sub/Note2.md");
			assert.ok(doc2);
			assert.equal(doc2.status, "active");

			// Verify atomic inventory persistence
			const loadedInventory = await loadSourceInventory("proj_scan_1", "src_scan_1", tmpDir);
			assert.equal(Object.keys(loadedInventory).length, 2);
			assert.ok(loadedInventory[doc1.id]);
			assert.ok(loadedInventory[doc2.id]);
			assert.equal(loadedInventory[doc1.id]!.contentHash, doc1.contentHash);

			// Verify sync with context.sources store
			const storeDocs = await context.sources.listDocuments("src_scan_1");
			assert.equal(storeDocs.length, 2);
		} finally {
			teardown();
		}
	});

	await t.test("unchanged second scan produces unchangedCount and identical hashes", async () => {
		setup();
		try {
			const pStore = createProjectStore(tmpDir);
			await pStore.createProject({ id: "proj_scan_2", name: "Scan Project 2" });

			const vRegistry = createVaultRegistry(tmpDir);
			await vRegistry.registerVault({
				id: "vault_scan_2",
				displayName: "Scan Vault 2",
				kind: "obsidian",
				bindings: [{ deviceId: "local", rootPath: vaultFolder, status: "available" }],
			});

			fs.writeFileSync(path.join(vaultFolder, "Article.md"), "Initial stable content.");

			const ctx = await (await import("../src/server/projects.ts")).resolveProjectContext("proj_scan_2", { dataDir: tmpDir });
			await ctx.sources.addSource({
				id: "src_scan_2",
				projectId: "proj_scan_2",
				vaultId: "vault_scan_2",
			});

			const firstResult = await scanSourceDocuments({
				projectId: "proj_scan_2",
				sourceId: "src_scan_2",
				dataDir: tmpDir,
			});
			assert.equal(firstResult.addedCount, 1);
			const firstRev = firstResult.documents[0]!.revisionId;
			const firstHash = firstResult.documents[0]!.contentHash;

			// Second scan with no disk changes
			const secondResult = await scanSourceDocuments({
				projectId: "proj_scan_2",
				sourceId: "src_scan_2",
				dataDir: tmpDir,
			});
			assert.equal(secondResult.scannedCount, 1);
			assert.equal(secondResult.addedCount, 0);
			assert.equal(secondResult.modifiedCount, 0);
			assert.equal(secondResult.unchangedCount, 1);
			assert.equal(secondResult.removedCount, 0);
			assert.equal(secondResult.documents[0]!.revisionId, firstRev);
			assert.equal(secondResult.documents[0]!.contentHash, firstHash);
		} finally {
			teardown();
		}
	});

	await t.test("modified note updates contentHash, increments modifiedCount and generates new revisionId", async () => {
		setup();
		try {
			const pStore = createProjectStore(tmpDir);
			await pStore.createProject({ id: "proj_mod", name: "Mod Project" });

			const vRegistry = createVaultRegistry(tmpDir);
			await vRegistry.registerVault({
				id: "vault_mod",
				displayName: "Mod Vault",
				kind: "obsidian",
				bindings: [{ deviceId: "local", rootPath: vaultFolder, status: "available" }],
			});

			fs.writeFileSync(path.join(vaultFolder, "DocA.md"), "Document A version 1");
			fs.writeFileSync(path.join(vaultFolder, "DocB.md"), "Document B version 1");

			const ctx = await (await import("../src/server/projects.ts")).resolveProjectContext("proj_mod", { dataDir: tmpDir });
			await ctx.sources.addSource({
				id: "src_mod",
				projectId: "proj_mod",
				vaultId: "vault_mod",
			});

			const initial = await scanSourceDocuments({
				projectId: "proj_mod",
				sourceId: "src_mod",
				dataDir: tmpDir,
			});
			assert.equal(initial.addedCount, 2);
			const docAInitial = initial.documents.find((d) => d.currentPath === "DocA.md")!;
			const docBInitial = initial.documents.find((d) => d.currentPath === "DocB.md")!;

			// Mutate DocA on disk
			fs.writeFileSync(path.join(vaultFolder, "DocA.md"), "Document A version 2 — updated factual proposition");

			const rescan = await scanSourceDocuments({
				projectId: "proj_mod",
				sourceId: "src_mod",
				dataDir: tmpDir,
			});
			assert.equal(rescan.scannedCount, 2);
			assert.equal(rescan.addedCount, 0);
			assert.equal(rescan.modifiedCount, 1);
			assert.equal(rescan.unchangedCount, 1);
			assert.equal(rescan.removedCount, 0);

			const docARescan = rescan.documents.find((d) => d.currentPath === "DocA.md")!;
			const docBRescan = rescan.documents.find((d) => d.currentPath === "DocB.md")!;

			assert.notEqual(docARescan.contentHash, docAInitial.contentHash);
			assert.notEqual(docARescan.revisionId, docAInitial.revisionId);
			assert.equal(docARescan.id, docAInitial.id); // Identity preserved!

			assert.equal(docBRescan.contentHash, docBInitial.contentHash);
			assert.equal(docBRescan.revisionId, docBInitial.revisionId);
		} finally {
			teardown();
		}
	});

	await t.test("deleted file sets status to missing without erasing inventory (Core Invariant 4)", async () => {
		setup();
		try {
			const pStore = createProjectStore(tmpDir);
			await pStore.createProject({ id: "proj_del", name: "Del Project" });

			const vRegistry = createVaultRegistry(tmpDir);
			await vRegistry.registerVault({
				id: "vault_del",
				displayName: "Del Vault",
				kind: "obsidian",
				bindings: [{ deviceId: "local", rootPath: vaultFolder, status: "available" }],
			});

			const file1 = path.join(vaultFolder, "Kept.md");
			const file2 = path.join(vaultFolder, "ToKill.md");
			fs.writeFileSync(file1, "Keep this file");
			fs.writeFileSync(file2, "Delete this file later");

			const ctx = await (await import("../src/server/projects.ts")).resolveProjectContext("proj_del", { dataDir: tmpDir });
			await ctx.sources.addSource({
				id: "src_del",
				projectId: "proj_del",
				vaultId: "vault_del",
			});

			const initial = await scanSourceDocuments({
				projectId: "proj_del",
				sourceId: "src_del",
				dataDir: tmpDir,
			});
			assert.equal(initial.addedCount, 2);

			// Delete ToKill.md from disk
			fs.unlinkSync(file2);

			const afterDelete = await scanSourceDocuments({
				projectId: "proj_del",
				sourceId: "src_del",
				dataDir: tmpDir,
			});

			assert.equal(afterDelete.scannedCount, 1);
			assert.equal(afterDelete.addedCount, 0);
			assert.equal(afterDelete.modifiedCount, 0);
			assert.equal(afterDelete.unchangedCount, 1);
			assert.equal(afterDelete.removedCount, 1);

			const killedDoc = afterDelete.documents.find((d) => d.currentPath === "ToKill.md");
			assert.ok(killedDoc);
			assert.equal(killedDoc.status, "missing");

			const keptDoc = afterDelete.documents.find((d) => d.currentPath === "Kept.md");
			assert.ok(keptDoc);
			assert.equal(keptDoc.status, "active");

			// Restoring file on disk marks it active again
			fs.writeFileSync(file2, "Reborn file");
			const afterRestore = await scanSourceDocuments({
				projectId: "proj_del",
				sourceId: "src_del",
				dataDir: tmpDir,
			});
			assert.equal(afterRestore.addedCount, 1);
			assert.equal(afterRestore.removedCount, 0);
			const restoredDoc = afterRestore.documents.find((d) => d.currentPath === "ToKill.md");
			assert.ok(restoredDoc);
			assert.equal(restoredDoc.status, "active");
		} finally {
			teardown();
		}
	});

	await t.test("disconnected vault safety: throws VaultUnavailableError and preserves inventory", async () => {
		setup();
		try {
			const pStore = createProjectStore(tmpDir);
			await pStore.createProject({ id: "proj_disc", name: "Disc Project" });

			const vRegistry = createVaultRegistry(tmpDir);
			const vault = await vRegistry.registerVault({
				id: "vault_disc",
				displayName: "Disc Vault",
				kind: "obsidian",
				bindings: [{ deviceId: "local", rootPath: vaultFolder, status: "available" }],
			});

			fs.writeFileSync(path.join(vaultFolder, "Sacred.md"), "Preserved learner note");

			const ctx = await (await import("../src/server/projects.ts")).resolveProjectContext("proj_disc", { dataDir: tmpDir });
			await ctx.sources.addSource({
				id: "src_disc",
				projectId: "proj_disc",
				vaultId: "vault_disc",
			});

			const initial = await scanSourceDocuments({
				projectId: "proj_disc",
				sourceId: "src_disc",
				dataDir: tmpDir,
			});
			assert.equal(initial.addedCount, 1);

			// Mark vault binding unavailable
			await vRegistry.updateBinding(vault.id, {
				deviceId: "local",
				rootPath: path.join(tmpDir, "non_existent_folder_xyz"),
				status: "unavailable",
			});

			// Scan should fail with VaultUnavailableError
			await assert.rejects(
				async () => {
					await scanSourceDocuments({
						projectId: "proj_disc",
						sourceId: "src_disc",
						dataDir: tmpDir,
					});
				},
				(err: unknown) => {
					assert.ok(err instanceof VaultUnavailableError);
					assert.equal(err.status, 409);
					assert.equal(err.code, "VAULT_UNAVAILABLE");
					return true;
				},
			);

			// Existing inventory must still be intact on disk!
			const savedInventory = await loadSourceInventory("proj_disc", "src_disc", tmpDir);
			assert.equal(Object.keys(savedInventory).length, 1);
			const sacredDoc = Object.values(savedInventory)[0];
			assert.ok(sacredDoc);
			assert.equal(sacredDoc.status, "active");
			assert.equal(sacredDoc.currentPath, "Sacred.md");
		} finally {
			teardown();
		}
	});

	await t.test("route handler: supports POST and GET with HTTP 200, 400, 404, 409", async () => {
		setup();
		try {
			const pStore = createProjectStore(tmpDir);
			await pStore.createProject({ id: "proj_route", name: "Route Project" });

			const vRegistry = createVaultRegistry(tmpDir);
			await vRegistry.registerVault({
				id: "vault_route",
				displayName: "Route Vault",
				kind: "obsidian",
				bindings: [{ deviceId: "local", rootPath: vaultFolder, status: "available" }],
			});

			fs.writeFileSync(path.join(vaultFolder, "RouteNote.md"), "Route test note");

			const ctx = await (await import("../src/server/projects.ts")).resolveProjectContext("proj_route", { dataDir: tmpDir });
			await ctx.sources.addSource({
				id: "src_route",
				projectId: "proj_route",
				vaultId: "vault_route",
			});

			// 1. Valid POST scan -> 200
			const postRes = await scanPostRoute(
				new Request("http://localhost/api/projects/proj_route/sources/src_route/scan", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ forceRescan: false }),
				}),
				{ params: Promise.resolve({ id: "proj_route", sourceId: "src_route" }) },
			);
			assert.equal(postRes.status, 200);
			const postData = await postRes.json();
			assert.equal(postData.scannedCount, 1);
			assert.equal(postData.addedCount, 1);

			// 2. Valid GET scan -> 200
			const getRes = await scanGetRoute(
				new Request("http://localhost/api/projects/proj_route/sources/src_route/scan"),
				{ params: Promise.resolve({ id: "proj_route", sourceId: "src_route" }) },
			);
			assert.equal(getRes.status, 200);
			const getData = await getRes.json();
			assert.equal(getData.unchangedCount, 1);

			// 3. Invalid Project ID -> 400
			const badProjRes = await scanPostRoute(
				new Request("http://localhost/api/projects/invalid!id/sources/src_route/scan", { method: "POST" }),
				{ params: Promise.resolve({ id: "invalid!id", sourceId: "src_route" }) },
			);
			assert.equal(badProjRes.status, 400);

			// 4. Invalid Source ID -> 400
			const badSrcRes = await scanPostRoute(
				new Request("http://localhost/api/projects/proj_route/sources/invalid!src/scan", { method: "POST" }),
				{ params: Promise.resolve({ id: "proj_route", sourceId: "invalid!src" }) },
			);
			assert.equal(badSrcRes.status, 400);

			// 5. Unknown Project -> 404
			const notFoundProj = await scanPostRoute(
				new Request("http://localhost/api/projects/proj_ghost/sources/src_route/scan", { method: "POST" }),
				{ params: Promise.resolve({ id: "proj_ghost", sourceId: "src_route" }) },
			);
			assert.equal(notFoundProj.status, 404);

			// 6. Unknown Source -> 404
			const notFoundSrc = await scanPostRoute(
				new Request("http://localhost/api/projects/proj_route/sources/src_ghost/scan", { method: "POST" }),
				{ params: Promise.resolve({ id: "proj_route", sourceId: "src_ghost" }) },
			);
			assert.equal(notFoundSrc.status, 404);

			// 7. Disconnected Vault -> 409
			await vRegistry.updateBinding("vault_route", {
				deviceId: "local",
				rootPath: path.join(tmpDir, "missing_vault"),
				status: "unavailable",
			});

			const conflictRes = await scanPostRoute(
				new Request("http://localhost/api/projects/proj_route/sources/src_route/scan", { method: "POST" }),
				{ params: Promise.resolve({ id: "proj_route", sourceId: "src_route" }) },
			);
			assert.equal(conflictRes.status, 409);
			const conflictData = await conflictRes.json();
			assert.equal(conflictData.code, "VAULT_UNAVAILABLE");
		} finally {
			teardown();
		}
	});

	await t.test("disconnected vault safety: unavailable binding with existing directory throws and preserves inventory", async () => {
		setup();
		try {
			const pStore = createProjectStore(tmpDir);
			await pStore.createProject({ id: "proj_disc_exist", name: "Disc Exist Project" });

			const vRegistry = createVaultRegistry(tmpDir);
			const vault = await vRegistry.registerVault({
				id: "vault_disc_exist",
				displayName: "Disc Exist Vault",
				kind: "obsidian",
				bindings: [{ deviceId: "local", rootPath: vaultFolder, status: "available" }],
			});

			fs.writeFileSync(path.join(vaultFolder, "Precious.md"), "Critical student notes");

			const ctx = await (await import("../src/server/projects.ts")).resolveProjectContext("proj_disc_exist", { dataDir: tmpDir });
			await ctx.sources.addSource({
				id: "src_disc_exist",
				projectId: "proj_disc_exist",
				vaultId: "vault_disc_exist",
			});

			// Initial scan creates active document
			const initial = await scanSourceDocuments({
				projectId: "proj_disc_exist",
				sourceId: "src_disc_exist",
				dataDir: tmpDir,
			});
			assert.equal(initial.addedCount, 1);
			assert.equal(initial.documents[0]?.status, "active");

			// Simulate unmounted drive: create an empty mount directory on disk, but binding status is "unavailable"
			const emptyMountDir = path.join(tmpDir, "empty_mount_point");
			fs.mkdirSync(emptyMountDir, { recursive: true });

			await vRegistry.updateBinding(vault.id, {
				deviceId: "local",
				rootPath: emptyMountDir,
				status: "unavailable",
			});

			// Scan MUST throw VaultUnavailableError despite emptyMountDir existing on disk
			await assert.rejects(
				async () => {
					await scanSourceDocuments({
						projectId: "proj_disc_exist",
						sourceId: "src_disc_exist",
						dataDir: tmpDir,
					});
				},
				(err: unknown) => {
					assert.ok(err instanceof VaultUnavailableError);
					assert.equal(err.status, 409);
					assert.equal(err.code, "VAULT_UNAVAILABLE");
					return true;
				},
			);

			// Core Invariant 4: Existing inventory MUST still be intact and NOT flipped to missing
			const savedInventory = await loadSourceInventory("proj_disc_exist", "src_disc_exist", tmpDir);
			assert.equal(Object.keys(savedInventory).length, 1);
			const preciousDoc = Object.values(savedInventory)[0];
			assert.ok(preciousDoc);
			assert.equal(preciousDoc.status, "active");
			assert.equal(preciousDoc.currentPath, "Precious.md");
		} finally {
			teardown();
		}
	});

	await t.test("scanner with exclude globs containing any or dummy.md preserves valid siblings", async () => {
		setup();
		try {
			const pStore = createProjectStore(tmpDir);
			await pStore.createProject({ id: "proj_glob", name: "Glob Project" });

			const vRegistry = createVaultRegistry(tmpDir);
			await vRegistry.registerVault({
				id: "vault_glob",
				displayName: "Glob Vault",
				kind: "obsidian",
				bindings: [{ deviceId: "local", rootPath: vaultFolder, status: "available" }],
			});

			// Create directory structure:
			// vault/notes/guide.md
			// vault/notes/dummy.md
			// vault/notes/any/child.md
			const notesDir = path.join(vaultFolder, "notes");
			const anyDir = path.join(notesDir, "any");
			fs.mkdirSync(anyDir, { recursive: true });
			fs.writeFileSync(path.join(notesDir, "guide.md"), "# Guide\nValid note.");
			fs.writeFileSync(path.join(notesDir, "dummy.md"), "# Dummy\nExcluded note.");
			fs.writeFileSync(path.join(anyDir, "child.md"), "# Child\nExcluded note.");

			const ctx = await (await import("../src/server/projects.ts")).resolveProjectContext("proj_glob", { dataDir: tmpDir });
			await ctx.sources.addSource({
				id: "src_glob",
				projectId: "proj_glob",
				vaultId: "vault_glob",
				exclude: [".obsidian/**", ".trash/**", ".git/**", "node_modules/**", "notes/dummy.md", "notes/any/**"],
			});

			const scanRes = await scanSourceDocuments({
				projectId: "proj_glob",
				sourceId: "src_glob",
				dataDir: tmpDir,
			});

			// Only notes/guide.md should be scanned
			assert.equal(scanRes.scannedCount, 1);
			assert.equal(scanRes.addedCount, 1);
			assert.equal(scanRes.documents.length, 1);
			assert.equal(scanRes.documents[0]?.currentPath, "notes/guide.md");
		} finally {
			teardown();
		}
	});

	await t.test("source store batch upsertDocuments updates records in single transaction", async () => {
		setup();
		try {
			const pStore = createProjectStore(tmpDir);
			await pStore.createProject({ id: "proj_batch", name: "Batch Project" });
			const ctx = await (await import("../src/server/projects.ts")).resolveProjectContext("proj_batch", { dataDir: tmpDir });

			assert.ok(typeof ctx.sources.upsertDocuments === "function");
			await ctx.sources.upsertDocuments([
				{
					id: "doc_1",
					sourceId: "src_1",
					vaultId: "v1",
					currentPath: "a.md",
					contentHash: "h1",
					revisionId: "r1",
					status: "active",
					sizeBytes: 10,
				},
				{
					id: "doc_2",
					sourceId: "src_1",
					vaultId: "v1",
					currentPath: "b.md",
					contentHash: "h2",
					revisionId: "r2",
					status: "active",
					sizeBytes: 20,
				},
			]);

			const docs = await ctx.sources.listDocuments("src_1");
			assert.equal(docs.length, 2);
			assert.ok(docs.some((d) => d.id === "doc_1"));
			assert.ok(docs.some((d) => d.id === "doc_2"));
		} finally {
			teardown();
		}
	});
});
