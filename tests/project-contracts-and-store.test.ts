import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
	projectIdSchema,
	projectSettingsSchema,
	projectSchema,
	vaultBindingSchema,
	vaultSchema,
	projectSourceSchema,
	sourceDocumentSchema,
	sourceEvidenceSchema,
	studyScopeSchema,
	projectContextSchema,
	DEFAULT_PROJECT_ID,
	DEFAULT_PROJECT_SETTINGS,
	type Project,
	type Vault,
	type ProjectSource,
	type SourceDocument,
	type SourceEvidence,
	type StudyScope,
} from "../src/core/contracts/project.ts";
import { createProjectStore } from "../src/store/projects.ts";

describe("Project Domain Contracts & Zod Schemas", () => {
	it("validates projectIdSchema with valid and invalid IDs", () => {
		assert.equal(projectIdSchema.parse("proj_123"), "proj_123");
		assert.equal(projectIdSchema.parse("default-workspace"), "default-workspace");
		assert.equal(projectIdSchema.parse(DEFAULT_PROJECT_ID), "proj_default");

		assert.throws(() => projectIdSchema.parse(""), /cannot be empty/);
		assert.throws(() => projectIdSchema.parse("has space"), /must contain only/);
		assert.throws(() => projectIdSchema.parse("path/traversal"), /must contain only/);
		assert.throws(() => projectIdSchema.parse("proj$bad!"), /must contain only/);
	});

	it("validates projectSettingsSchema defaults and strict values", () => {
		const valid = projectSettingsSchema.parse(DEFAULT_PROJECT_SETTINGS);
		assert.deepEqual(valid, {
			defaultStudyScope: "all",
			sourceGrounding: "strict",
		});

		assert.throws(() =>
			projectSettingsSchema.parse({
				defaultStudyScope: "invalid",
				sourceGrounding: "strict",
			}),
		);
	});

	it("validates full Project schema", () => {
		const validProj: Project = {
			id: "proj_quantum",
			name: "Quantum Mechanics",
			description: "Study of wave mechanics and operators",
			status: "active",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			settings: {
				defaultStudyScope: "manual",
				sourceGrounding: "assisted",
			},
		};
		const parsed = projectSchema.parse(validProj);
		assert.equal(parsed.id, "proj_quantum");
		assert.equal(parsed.status, "active");

		assert.throws(() => projectSchema.parse({ ...validProj, name: "" }));
		assert.throws(() => projectSchema.parse({ ...validProj, status: "unknown" }));
	});

	it("validates Vault and VaultBinding schemas", () => {
		const validVault: Vault = {
			id: "vault_main",
			displayName: "Obsidian Notes",
			kind: "obsidian",
			bindings: [
				{
					deviceId: "macbook-air",
					rootPath: "/Users/alice/Documents/Notes",
					status: "available",
				},
				{
					deviceId: "desktop-linux",
					rootPath: "/home/alice/Notes",
					status: "unavailable",
				},
			],
		};
		const parsed = vaultSchema.parse(validVault);
		assert.equal(parsed.bindings.length, 2);
		assert.equal(parsed.kind, "obsidian");

		assert.throws(() => vaultBindingSchema.parse({ deviceId: "", rootPath: "/p", status: "available" }));
		assert.throws(() => vaultSchema.parse({ ...validVault, kind: "not-obsidian" }));
	});

	it("validates ProjectSource schema", () => {
		const validSource: ProjectSource = {
			id: "src_001",
			projectId: "proj_quantum",
			vaultId: "vault_main",
			include: ["**/*.md"],
			exclude: [".obsidian/**", ".trash/**"],
			recursive: true,
			enabled: true,
			syncMode: "automatic",
			deletionPolicy: "deactivate",
			createdAt: new Date().toISOString(),
		};
		const parsed = projectSourceSchema.parse(validSource);
		assert.equal(parsed.recursive, true);
		assert.equal(parsed.syncMode, "automatic");

		assert.throws(() => projectSourceSchema.parse({ ...validSource, syncMode: "other" }));
		assert.throws(() => projectSourceSchema.parse({ ...validSource, deletionPolicy: "purge" }));
	});

	it("validates SourceDocument schema", () => {
		const validDoc: SourceDocument = {
			id: "doc_schrodinger",
			sourceId: "src_001",
			vaultId: "vault_main",
			currentPath: "Physics/Quantum/Schrodinger.md",
			contentHash: "sha256:abc123def456",
			revisionId: "rev_1",
			status: "active",
			indexedAt: new Date().toISOString(),
		};
		const parsed = sourceDocumentSchema.parse(validDoc);
		assert.equal(parsed.status, "active");

		const missingDoc: SourceDocument = {
			...validDoc,
			status: "missing",
		};
		assert.equal(sourceDocumentSchema.parse(missingDoc).status, "missing");
		assert.throws(() => sourceDocumentSchema.parse({ ...validDoc, status: "corrupted" }));
	});

	it("validates SourceEvidence schema with provenance and location", () => {
		const validEvidence: SourceEvidence = {
			id: "ev_001",
			projectId: "proj_quantum",
			sourceId: "src_001",
			documentId: "doc_schrodinger",
			revisionId: "rev_1",
			propositionId: "prop_wavefunction",
			location: {
				heading: "The Time-Dependent Equation",
				blockId: "^tdse",
				startOffset: 120,
				endOffset: 450,
			},
			provenance: "explicit-source",
			status: "active",
			extractorVersion: "2026-10-26",
		};
		const parsed = sourceEvidenceSchema.parse(validEvidence);
		assert.equal(parsed.provenance, "explicit-source");
		assert.equal(parsed.location.startOffset, 120);

		const inferredEvidence: SourceEvidence = {
			...validEvidence,
			provenance: "model-inferred",
			status: "superseded",
		};
		assert.equal(sourceEvidenceSchema.parse(inferredEvidence).provenance, "model-inferred");
		assert.throws(() => sourceEvidenceSchema.parse({ ...validEvidence, provenance: "hallucination" }));
	});

	it("validates StudyScope schema", () => {
		const validScope: StudyScope = {
			projectId: "proj_quantum",
			sourceIds: ["src_001"],
			includePrerequisites: true,
			grounding: "sources-only",
		};
		const parsed = studyScopeSchema.parse(validScope);
		assert.equal(parsed.grounding, "sources-only");
		assert.equal(parsed.includePrerequisites, true);

		assert.throws(() => studyScopeSchema.parse({ ...validScope, grounding: "unrestricted" }));
	});

	it("validates ProjectContext schema shape", () => {
		const mockContext = {
			projectId: "proj_default",
			chats: {} as any,
			graph: {} as any,
			jobs: {} as any,
			practice: {} as any,
			sources: {} as any,
		};
		const parsed = projectContextSchema.parse(mockContext);
		assert.equal(parsed.projectId, "proj_default");

		assert.throws(() => projectContextSchema.parse({ ...mockContext, chats: null }));
	});
});

describe("ProjectStore (CRUD, isolation, and persistence)", () => {
	let tmpDir: string;
	let store: ReturnType<typeof createProjectStore>;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-test-projectstore-"));
		store = createProjectStore(tmpDir);
	});

	afterEach(() => {
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup error
		}
	});

	it("starts with an empty project list", async () => {
		const list = await store.listProjects();
		assert.deepEqual(list, []);
		assert.equal(await store.getActiveProjectId(), null);
	});

	it("creates a new project and auto-initializes directory structure and global entry", async () => {
		const project = await store.createProject({
			name: "Linear Algebra",
			description: "Matrices, eigenvalues, vector spaces",
		});

		assert.ok(project.id.startsWith("proj_"));
		assert.equal(project.name, "Linear Algebra");
		assert.equal(project.description, "Matrices, eigenvalues, vector spaces");
		assert.equal(project.status, "active");
		assert.deepEqual(project.settings, DEFAULT_PROJECT_SETTINGS);

		// Verify per-project directory structure
		const pDir = path.join(tmpDir, "projects", project.id);
		assert.ok(fs.existsSync(pDir));
		assert.ok(fs.existsSync(path.join(pDir, "project.json")));
		assert.ok(fs.existsSync(path.join(pDir, "chats")));
		assert.ok(fs.existsSync(path.join(pDir, "graph")));
		assert.ok(fs.existsSync(path.join(pDir, "jobs")));
		assert.ok(fs.existsSync(path.join(pDir, "practice")));
		assert.ok(fs.existsSync(path.join(pDir, "sources")));
		assert.ok(fs.existsSync(path.join(pDir, "index")));

		// Verify global projects.json
		const globalFile = path.join(tmpDir, "global", "projects.json");
		assert.ok(fs.existsSync(globalFile));
		const globalRaw = JSON.parse(fs.readFileSync(globalFile, "utf8"));
		assert.equal(globalRaw.activeProjectId, project.id);
		assert.equal(globalRaw.projects.length, 1);
		assert.equal(globalRaw.projects[0].id, project.id);

		// First created project becomes active project
		assert.equal(await store.getActiveProjectId(), project.id);
	});

	it("supports custom ID creation and rejects duplicate or invalid IDs", async () => {
		const custom = await store.createProject({
			id: "proj_custom_1",
			name: "Custom Project",
		});
		assert.equal(custom.id, "proj_custom_1");

		await assert.rejects(
			() => store.createProject({ id: "proj_custom_1", name: "Duplicate ID" }),
			/already exists/,
		);

		await assert.rejects(
			() => store.createProject({ id: "invalid id with spaces", name: "Invalid" }),
			/Invalid projectId format/,
		);
	});

	it("rejects project creation with empty name", async () => {
		await assert.rejects(
			() => store.createProject({ name: "   " }),
			/Project name cannot be empty/,
		);
	});

	it("retrieves project by id and returns null for unknown/invalid ids", async () => {
		const created = await store.createProject({ name: "Mechanics" });
		const fetched = await store.getProject(created.id);
		assert.deepEqual(fetched, created);

		assert.equal(await store.getProject("proj_non_existent"), null);
		assert.equal(await store.getProject(""), null);
		assert.equal(await store.getProject("invalid/traversal"), null);
	});

	it("lists all created projects", async () => {
		const p1 = await store.createProject({ name: "Project 1" });
		const p2 = await store.createProject({ name: "Project 2" });

		const list = await store.listProjects();
		assert.equal(list.length, 2);
		assert.ok(list.some((p) => p.id === p1.id));
		assert.ok(list.some((p) => p.id === p2.id));
	});

	it("updates project fields and persists changes to project.json and global registry", async () => {
		const p = await store.createProject({ name: "Initial Name" });
		const updated = await store.updateProject(p.id, {
			name: "Renamed Project",
			description: "Updated description",
			settings: {
				defaultStudyScope: "manual",
				sourceGrounding: "assisted",
			},
		});

		assert.equal(updated.name, "Renamed Project");
		assert.equal(updated.description, "Updated description");
		assert.equal(updated.settings.defaultStudyScope, "manual");
		assert.equal(updated.settings.sourceGrounding, "assisted");
		assert.ok(new Date(updated.updatedAt).getTime() >= new Date(p.updatedAt).getTime());

		// Verify on-disk project.json
		const onDisk = await store.getProject(p.id);
		assert.equal(onDisk?.name, "Renamed Project");
		assert.equal(onDisk?.settings.defaultStudyScope, "manual");
	});

	it("archives a project by setting status to archived", async () => {
		const p = await store.createProject({ name: "To Archive" });
		assert.equal(p.status, "active");

		await store.archiveProject(p.id);

		const archived = await store.getProject(p.id);
		assert.equal(archived?.status, "archived");
	});

	it("deletes a project and removes its directory", async () => {
		const p = await store.createProject({ name: "To Delete" });
		const pDir = path.join(tmpDir, "projects", p.id);
		assert.ok(fs.existsSync(pDir));

		const deleted = await store.deleteProject(p.id);
		assert.equal(deleted, true);
		assert.equal(await store.getProject(p.id), null);
		assert.ok(!fs.existsSync(pDir));

		const list = await store.listProjects();
		assert.equal(list.length, 0);
	});

	it("sets and persists active project id", async () => {
		const p1 = await store.createProject({ name: "P1" });
		const p2 = await store.createProject({ name: "P2" });

		assert.equal(await store.getActiveProjectId(), p1.id);

		await store.setActiveProjectId(p2.id);
		assert.equal(await store.getActiveProjectId(), p2.id);

		await assert.rejects(
			() => store.setActiveProjectId("proj_does_not_exist"),
			/not found/,
		);
	});

	it("handles concurrent project creations safely", async () => {
		const creations = Array.from({ length: 10 }, (_, i) =>
			store.createProject({ name: `Concurrent Project ${i}` }),
		);
		const results = await Promise.all(creations);
		assert.equal(results.length, 10);

		const list = await store.listProjects();
		assert.equal(list.length, 10);
	});

	it("keeps separate stores in distinct directories completely isolated", async () => {
		const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "lh-test-store2-"));
		try {
			const store2 = createProjectStore(tmpDir2);
			await store.createProject({ name: "Store 1 Project" });
			await store2.createProject({ name: "Store 2 Project" });

			const list1 = await store.listProjects();
			const list2 = await store2.listProjects();

			assert.equal(list1.length, 1);
			assert.ok(list1[0]);
			assert.equal(list1[0].name, "Store 1 Project");

			assert.equal(list2.length, 1);
			assert.ok(list2[0]);
			assert.equal(list2[0].name, "Store 2 Project");
		} finally {
			fs.rmSync(tmpDir2, { recursive: true, force: true });
		}
	});
});
