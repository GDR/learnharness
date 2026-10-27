import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	type StudyScope,
	type StudyScopeType,
	type SourceGroundingMode,
	studyScopeTypes,
	sourceGroundingModes,
	studyScopeSchema,
	studyScopeTypeSchema,
	sourceGroundingModeSchema,
	validateStudyScope,
	InvalidStudyScopeError,
	DEFAULT_STUDY_SCOPE,
	createDefaultStudyScope,
	inferStudyScopeType,
	resolveSessionScope,
} from "../src/core/contracts/scope.ts";

describe("StudyScope Contracts & Zod Schemas", () => {
	describe("Constants & Type Schemas", () => {
		it("enumerates all 5 supported study scope types", () => {
			assert.deepEqual(studyScopeTypes, ["project", "source", "document", "tag", "proposition"]);
			for (const t of studyScopeTypes) {
				assert.equal(studyScopeTypeSchema.parse(t), t);
			}
			assert.throws(() => studyScopeTypeSchema.parse("invalid_scope"));
			assert.throws(() => studyScopeTypeSchema.parse(""));
		});

		it("enumerates grounding modes", () => {
			assert.deepEqual(sourceGroundingModes, ["sources-only", "sources-plus-external"]);
			assert.equal(sourceGroundingModeSchema.parse("sources-only"), "sources-only");
			assert.equal(sourceGroundingModeSchema.parse("sources-plus-external"), "sources-plus-external");
			assert.throws(() => sourceGroundingModeSchema.parse("unrestricted"));
		});
	});

	describe("Validation of All 5 Scope Types", () => {
		it("validates project scope with defaults", () => {
			const raw = {
				type: "project" as StudyScopeType,
				projectId: "proj_math",
			};
			const parsed = studyScopeSchema.parse(raw);
			assert.equal(parsed.type, "project");
			assert.equal(parsed.projectId, "proj_math");
			assert.equal(parsed.includePrerequisites, false);
			assert.equal(parsed.grounding, "sources-only");
		});

		it("validates source scope with non-empty sourceIds", () => {
			const raw = {
				type: "source" as StudyScopeType,
				projectId: "proj_physics",
				sourceIds: ["src_vault_1", "src_vault_2"],
				includePrerequisites: true,
				grounding: "sources-plus-external" as SourceGroundingMode,
			};
			const parsed = studyScopeSchema.parse(raw);
			assert.equal(parsed.type, "source");
			assert.deepEqual(parsed.sourceIds, ["src_vault_1", "src_vault_2"]);
			assert.equal(parsed.includePrerequisites, true);
			assert.equal(parsed.grounding, "sources-plus-external");
		});

		it("rejects source scope with empty or missing sourceIds", () => {
			assert.throws(
				() => studyScopeSchema.parse({ type: "source", sourceIds: [] }),
				/Scope type 'source' requires at least one sourceId/,
			);
			assert.throws(
				() => studyScopeSchema.parse({ type: "source" }),
				/Scope type 'source' requires at least one sourceId/,
			);
		});

		it("validates document scope with non-empty documentIds", () => {
			const raw = {
				type: "document" as StudyScopeType,
				documentIds: ["doc_quantum_notes", "doc_relativity"],
			};
			const parsed = studyScopeSchema.parse(raw);
			assert.equal(parsed.type, "document");
			assert.deepEqual(parsed.documentIds, ["doc_quantum_notes", "doc_relativity"]);
			assert.equal(parsed.includePrerequisites, false);
			assert.equal(parsed.grounding, "sources-only");
		});

		it("rejects document scope with empty or missing documentIds", () => {
			assert.throws(
				() => studyScopeSchema.parse({ type: "document", documentIds: [] }),
				/Scope type 'document' requires at least one documentId/,
			);
			assert.throws(
				() => studyScopeSchema.parse({ type: "document" }),
				/Scope type 'document' requires at least one documentId/,
			);
		});

		it("validates tag scope with tagNames or tags", () => {
			const withTagNames = studyScopeSchema.parse({
				type: "tag" as StudyScopeType,
				tagNames: ["#algebra", "#calculus"],
			});
			assert.equal(withTagNames.type, "tag");
			assert.deepEqual(withTagNames.tagNames, ["#algebra", "#calculus"]);
			assert.deepEqual(withTagNames.tags, ["#algebra", "#calculus"]);

			const withTags = studyScopeSchema.parse({
				type: "tag" as StudyScopeType,
				tags: ["#quantum"],
			});
			assert.equal(withTags.type, "tag");
			assert.deepEqual(withTags.tags, ["#quantum"]);
			assert.deepEqual(withTags.tagNames, ["#quantum"]);
		});

		it("rejects tag scope with empty tag arrays", () => {
			assert.throws(
				() => studyScopeSchema.parse({ type: "tag", tagNames: [] }),
				/Scope type 'tag' requires at least one tag/,
			);
			assert.throws(
				() => studyScopeSchema.parse({ type: "tag", tags: [] }),
				/Scope type 'tag' requires at least one tag/,
			);
			assert.throws(
				() => studyScopeSchema.parse({ type: "tag" }),
				/Scope type 'tag' requires at least one tag/,
			);
		});

		it("validates proposition scope with non-empty propositionIds", () => {
			const raw = {
				type: "proposition" as StudyScopeType,
				propositionIds: ["prop_pythagorean_thm", "prop_fermat"],
			};
			const parsed = studyScopeSchema.parse(raw);
			assert.equal(parsed.type, "proposition");
			assert.deepEqual(parsed.propositionIds, ["prop_pythagorean_thm", "prop_fermat"]);
		});

		it("rejects proposition scope with empty or missing propositionIds", () => {
			assert.throws(
				() => studyScopeSchema.parse({ type: "proposition", propositionIds: [] }),
				/Scope type 'proposition' requires at least one propositionId/,
			);
			assert.throws(
				() => studyScopeSchema.parse({ type: "proposition" }),
				/Scope type 'proposition' requires at least one propositionId/,
			);
		});
	});

	describe("Type Inference from Fields", () => {
		it("infers 'source' when sourceIds is populated and type is omitted", () => {
			const parsed = studyScopeSchema.parse({
				sourceIds: ["src_alpha"],
			});
			assert.equal(parsed.type, "source");
			assert.deepEqual(parsed.sourceIds, ["src_alpha"]);
		});

		it("infers 'document' when documentIds is populated and type is omitted", () => {
			const parsed = studyScopeSchema.parse({
				documentIds: ["doc_chapter_1"],
			});
			assert.equal(parsed.type, "document");
			assert.deepEqual(parsed.documentIds, ["doc_chapter_1"]);
		});

		it("infers 'tag' when tags or tagNames is populated and type is omitted", () => {
			const parsedFromTags = studyScopeSchema.parse({
				tags: ["#geometry"],
			});
			assert.equal(parsedFromTags.type, "tag");

			const parsedFromTagNames = studyScopeSchema.parse({
				tagNames: ["#topology"],
			});
			assert.equal(parsedFromTagNames.type, "tag");
		});

		it("infers 'proposition' when propositionIds is populated and type is omitted", () => {
			const parsed = studyScopeSchema.parse({
				propositionIds: ["prop_101"],
			});
			assert.equal(parsed.type, "proposition");
			assert.deepEqual(parsed.propositionIds, ["prop_101"]);
		});

		it("defaults to 'project' when no target collections are present", () => {
			const parsed = studyScopeSchema.parse({});
			assert.equal(parsed.type, "project");
			assert.equal(parsed.includePrerequisites, false);
			assert.equal(parsed.grounding, "sources-only");
		});

		it("inferStudyScopeType pure function matches schema behavior", () => {
			assert.equal(inferStudyScopeType({ sourceIds: ["s1"] }), "source");
			assert.equal(inferStudyScopeType({ documentIds: ["d1"] }), "document");
			assert.equal(inferStudyScopeType({ tags: ["t1"] }), "tag");
			assert.equal(inferStudyScopeType({ tagNames: ["t1"] }), "tag");
			assert.equal(inferStudyScopeType({ propositionIds: ["p1"] }), "proposition");
			assert.equal(inferStudyScopeType({}), "project");
			assert.equal(inferStudyScopeType({ type: "tag", sourceIds: ["s1"] }), "tag");
		});
	});

	describe("validateStudyScope Helper", () => {
		it("returns validated StudyScope object", () => {
			const valid: StudyScope = {
				projectId: "proj_valid",
				sourceIds: ["src_01"],
			};
			const res = validateStudyScope(valid);
			assert.equal(res.type, "source");
			assert.equal(res.projectId, "proj_valid");
			assert.deepEqual(res.sourceIds, ["src_01"]);
		});

		it("throws InvalidStudyScopeError with status 400 on invalid input", () => {
			assert.throws(
				() => validateStudyScope(null),
				(err: unknown) => err instanceof InvalidStudyScopeError && err.status === 400,
			);
			assert.throws(
				() => validateStudyScope("invalid_string"),
				(err: unknown) => err instanceof InvalidStudyScopeError && err.status === 400,
			);
			assert.throws(
				() => validateStudyScope({ type: "source", sourceIds: [] }),
				(err: unknown) => err instanceof InvalidStudyScopeError && err.status === 400,
			);
			assert.throws(
				() => validateStudyScope({ grounding: "invalid_grounding" }),
				(err: unknown) => err instanceof InvalidStudyScopeError && err.status === 400,
			);
		});
	});

	describe("Defaults and Session Scope Resolution", () => {
		it("provides DEFAULT_STUDY_SCOPE constant", () => {
			assert.equal(DEFAULT_STUDY_SCOPE.type, "project");
			assert.equal(DEFAULT_STUDY_SCOPE.includePrerequisites, false);
			assert.equal(DEFAULT_STUDY_SCOPE.grounding, "sources-only");
		});

		it("createDefaultStudyScope creates fresh project scope with optional projectId", () => {
			const scope1 = createDefaultStudyScope();
			assert.equal(scope1.type, "project");
			assert.equal(scope1.projectId, undefined);

			const scope2 = createDefaultStudyScope("proj_abc");
			assert.equal(scope2.type, "project");
			assert.equal(scope2.projectId, "proj_abc");
		});

		it("resolveSessionScope resolves legacy sessions without scope safely", () => {
			const legacySession = { projectId: "proj_legacy" };
			const resolved = resolveSessionScope(legacySession);
			assert.equal(resolved.type, "project");
			assert.equal(resolved.projectId, "proj_legacy");
			assert.equal(resolved.includePrerequisites, false);
			assert.equal(resolved.grounding, "sources-only");
		});

		it("resolveSessionScope uses defaultProjectId if session lacks both scope and projectId", () => {
			const blankSession = {};
			const resolved = resolveSessionScope(blankSession, "proj_fallback");
			assert.equal(resolved.type, "project");
			assert.equal(resolved.projectId, "proj_fallback");
		});

		it("resolveSessionScope preserves existing explicit scope on session", () => {
			const scopedSession = {
				scope: {
					type: "source" as StudyScopeType,
					sourceIds: ["src_alpha"],
					includePrerequisites: true,
					grounding: "sources-plus-external" as SourceGroundingMode,
				},
				projectId: "proj_main",
			};
			const resolved = resolveSessionScope(scopedSession);
			assert.equal(resolved.type, "source");
			assert.deepEqual(resolved.sourceIds, ["src_alpha"]);
			assert.equal(resolved.includePrerequisites, true);
			assert.equal(resolved.grounding, "sources-plus-external");
			assert.equal(resolved.projectId, "proj_main");
		});

		it("resolveSessionScope infers type if explicit scope lacks type", () => {
			const scopedSession = {
				scope: {
					documentIds: ["doc_deep"],
				},
			};
			const resolved = resolveSessionScope(scopedSession, "proj_default");
			assert.equal(resolved.type, "document");
			assert.deepEqual(resolved.documentIds, ["doc_deep"]);
			assert.equal(resolved.projectId, "proj_default");
		});
	});
});
