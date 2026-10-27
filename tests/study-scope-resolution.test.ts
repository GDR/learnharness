import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
	validateAndResolveStudyScope,
	DocumentNotFoundError,
	ScopeResolutionError,
	InvalidStudyScopeError,
} from "../src/server/scope.ts";
import { SourceNotFoundError } from "../src/core/contracts/project.ts";
import type { ProjectContext } from "../src/core/contracts/project.ts";
import { createSourceStore } from "../src/store/sources.ts";

describe("Server StudyScope Resolution & Boundary Validation", () => {
	let testTmpDir: string;
	let sourcesDirA: string;
	let sourcesDirB: string;
	let contextA: ProjectContext;
	let contextB: ProjectContext;

	beforeEach(async () => {
		testTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-scope-resolution-test-"));
		sourcesDirA = path.join(testTmpDir, "sources_a");
		sourcesDirB = path.join(testTmpDir, "sources_b");

		const storeA = createSourceStore(sourcesDirA);
		const storeB = createSourceStore(sourcesDirB);

		// Seed project A with source and documents
		const srcA = await storeA.addSource({
			projectId: "proj_a",
			vaultId: "vault_a",
			id: "src_a_1",
		});
		await storeA.upsertDocument({
			id: "doc_a_note1",
			projectId: "proj_a",
			sourceId: srcA.id,
			vaultId: "vault_a",
			currentPath: "Notes/Note1.md",
			contentHash: "abc123hash",
			revisionId: "rev_1",
			status: "active",
		});

		// Seed project B with source and documents
		const srcB = await storeB.addSource({
			projectId: "proj_b",
			vaultId: "vault_b",
			id: "src_b_1",
		});
		await storeB.upsertDocument({
			id: "doc_b_secret",
			projectId: "proj_b",
			sourceId: srcB.id,
			vaultId: "vault_b",
			currentPath: "Secret/Classified.md",
			contentHash: "secret123hash",
			revisionId: "rev_1",
			status: "active",
		});


		// Minimal mock context for A and B
		contextA = {
			projectId: "proj_a",
			sources: storeA,
			chats: {} as any,
			graph: {} as any,
			jobs: {} as any,
			practice: {} as any,
		};

		contextB = {
			projectId: "proj_b",
			sources: storeB,
			chats: {} as any,
			graph: {} as any,
			jobs: {} as any,
			practice: {} as any,
		};
	});

	afterEach(() => {
		if (testTmpDir && fs.existsSync(testTmpDir)) {
			fs.rmSync(testTmpDir, { recursive: true, force: true });
		}
	});

	describe("Project Scope Resolution", () => {
		it("resolves default project scope when rawScope is null or undefined", async () => {
			const resolved = await validateAndResolveStudyScope(null, contextA);
			assert.equal(resolved.type, "project");
			assert.equal(resolved.projectId, "proj_a");
			assert.equal(resolved.includePrerequisites, false);
			assert.equal(resolved.grounding, "sources-only");
			assert.deepEqual(resolved.resolvedSourceIds, []);
			assert.deepEqual(resolved.resolvedDocumentIds, []);
		});

		it("resolves explicit project scope matching context projectId", async () => {
			const resolved = await validateAndResolveStudyScope(
				{ type: "project", projectId: "proj_a", includePrerequisites: true },
				contextA,
			);
			assert.equal(resolved.type, "project");
			assert.equal(resolved.projectId, "proj_a");
			assert.equal(resolved.includePrerequisites, true);
		});

		it("rejects mismatched projectId with ScopeResolutionError (status 400)", async () => {
			await assert.rejects(
				async () => validateAndResolveStudyScope({ type: "project", projectId: "proj_b" }, contextA),
				(err: unknown) =>
					err instanceof ScopeResolutionError &&
					err.status === 400 &&
					err.message.includes("does not match context projectId"),
			);
		});
	});

	describe("Source Scope Resolution & Existence Checks", () => {
		it("resolves valid source scope when source exists in project", async () => {
			const resolved = await validateAndResolveStudyScope(
				{ type: "source", sourceIds: ["src_a_1"] },
				contextA,
			);
			assert.equal(resolved.type, "source");
			assert.equal(resolved.projectId, "proj_a");
			assert.deepEqual(resolved.resolvedSourceIds, ["src_a_1"]);
		});

		it("throws SourceNotFoundError (status 404) for non-existent source", async () => {
			await assert.rejects(
				async () =>
					validateAndResolveStudyScope(
						{ type: "source", sourceIds: ["src_non_existent"] },
						contextA,
					),
				(err: unknown) => err instanceof SourceNotFoundError && err.status === 404,
			);
		});

		it("enforces cross-project boundary: cannot resolve source from project B in project A", async () => {
			await assert.rejects(
				async () =>
					validateAndResolveStudyScope(
						{ type: "source", sourceIds: ["src_b_1"] },
						contextA,
					),
				(err: unknown) => err instanceof SourceNotFoundError && err.status === 404,
			);
		});
	});

	describe("Document Scope Resolution & Existence Checks", () => {
		it("resolves valid document scope when document exists in project sources", async () => {
			const resolved = await validateAndResolveStudyScope(
				{ type: "document", documentIds: ["doc_a_note1"] },
				contextA,
			);
			assert.equal(resolved.type, "document");
			assert.equal(resolved.projectId, "proj_a");
			assert.deepEqual(resolved.resolvedDocumentIds, ["doc_a_note1"]);
		});

		it("throws DocumentNotFoundError (status 404) for non-existent document", async () => {
			await assert.rejects(
				async () =>
					validateAndResolveStudyScope(
						{ type: "document", documentIds: ["doc_missing"] },
						contextA,
					),
				(err: unknown) => err instanceof DocumentNotFoundError && err.status === 404,
			);
		});

		it("enforces cross-project boundary: cannot resolve document from project B in project A", async () => {
			await assert.rejects(
				async () =>
					validateAndResolveStudyScope(
						{ type: "document", documentIds: ["doc_b_secret"] },
						contextA,
					),
				(err: unknown) => err instanceof DocumentNotFoundError && err.status === 404,
			);
		});
	});

	describe("Tag and Proposition Scope Resolution", () => {
		it("resolves tag scope with tagNames and tags", async () => {
			const resolved = await validateAndResolveStudyScope(
				{ type: "tag", tagNames: ["#physics", "#thermodynamics"] },
				contextA,
			);
			assert.equal(resolved.type, "tag");
			assert.deepEqual(resolved.tagNames, ["#physics", "#thermodynamics"]);
			assert.deepEqual(resolved.tags, ["#physics", "#thermodynamics"]);
		});

		it("resolves proposition scope with propositionIds", async () => {
			const resolved = await validateAndResolveStudyScope(
				{ type: "proposition", propositionIds: ["prop_1", "prop_2"] },
				contextA,
			);
			assert.equal(resolved.type, "proposition");
			assert.deepEqual(resolved.resolvedPropositionIds, ["prop_1", "prop_2"]);
		});
	});

	describe("Error Handling on Invalid Scopes and Context", () => {
		it("throws InvalidStudyScopeError (status 400) on malformed scope shapes", async () => {
			await assert.rejects(
				async () => validateAndResolveStudyScope("invalid_string_scope", contextA),
				(err: unknown) => err instanceof InvalidStudyScopeError && err.status === 400,
			);

			await assert.rejects(
				async () => validateAndResolveStudyScope({ type: "source", sourceIds: [] }, contextA),
				(err: unknown) => err instanceof InvalidStudyScopeError && err.status === 400,
			);

			await assert.rejects(
				async () => validateAndResolveStudyScope({ type: "document", documentIds: [] }, contextA),
				(err: unknown) => err instanceof InvalidStudyScopeError && err.status === 400,
			);
		});

		it("throws ScopeResolutionError when context is missing or lacks projectId", async () => {
			await assert.rejects(
				async () => validateAndResolveStudyScope({ type: "project" }, null as any),
				(err: unknown) => err instanceof ScopeResolutionError && err.status === 400,
			);
		});
	});
});
