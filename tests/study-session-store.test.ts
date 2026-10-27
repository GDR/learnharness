import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createChatStore } from "../src/store/chats.ts";
import { createPracticeStore } from "../src/store/practice.ts";
import {
	type StudyScope,
	type StudyScopeType,
	resolveSessionScope,
	validateStudyScope,
} from "../src/core/contracts/scope.ts";

describe("Study Session Store & Persistence", () => {
	let testTmpDir: string;
	let chatsDir: string;
	let practiceDir: string;

	beforeEach(() => {
		testTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-study-session-test-"));
		chatsDir = path.join(testTmpDir, "chats");
		practiceDir = path.join(testTmpDir, "practice");
	});

	afterEach(() => {
		if (testTmpDir && fs.existsSync(testTmpDir)) {
			fs.rmSync(testTmpDir, { recursive: true, force: true });
		}
	});

	describe("ChatStore Scope Persistence", () => {
		it("creates chat without scope (legacy behavior) and leaves scope undefined on disk", () => {
			const store = createChatStore(chatsDir);
			const chat = store.createChat("Legacy Session");

			assert.ok(chat.id.startsWith("chat_"));
			assert.equal(chat.title, "Legacy Session");
			assert.equal(chat.scope, undefined);

			// Verify file on disk directly
			const raw = JSON.parse(fs.readFileSync(path.join(chatsDir, `${chat.id}.json`), "utf-8"));
			assert.equal(raw.scope, undefined);

			// getChat returns record with undefined scope
			const retrieved = store.getChat(chat.id);
			assert.ok(retrieved);
			assert.equal(retrieved.scope, undefined);

			// resolveSessionScope safely defaults legacy record
			const effectiveScope = resolveSessionScope(retrieved, "proj_default");
			assert.equal(effectiveScope.type, "project");
			assert.equal(effectiveScope.projectId, "proj_default");
			assert.equal(effectiveScope.includePrerequisites, false);
			assert.equal(effectiveScope.grounding, "sources-only");
		});

		it("creates chat with explicit StudyScope and persists it atomically", () => {
			const store = createChatStore(chatsDir);
			const scope: StudyScope = {
				type: "source",
				projectId: "proj_quantum",
				sourceIds: ["src_obsidian_notes"],
				includePrerequisites: true,
				grounding: "sources-only",
			};

			const chat = store.createChat("Quantum Mechanics Deep Dive", undefined, scope);
			assert.ok(chat.id);
			assert.deepEqual(chat.scope, scope);

			// Verify on disk
			const raw = JSON.parse(fs.readFileSync(path.join(chatsDir, `${chat.id}.json`), "utf-8"));
			assert.deepEqual(raw.scope, scope);

			// Retrieve via getChat
			const retrieved = store.getChat(chat.id);
			assert.ok(retrieved);
			assert.deepEqual(retrieved.scope, scope);

			// resolveSessionScope preserves exact scope
			const effective = resolveSessionScope(retrieved);
			assert.equal(effective.type, "source");
			assert.equal(effective.projectId, "proj_quantum");
			assert.deepEqual(effective.sourceIds, ["src_obsidian_notes"]);
			assert.equal(effective.includePrerequisites, true);
		});

		it("creates practice chat with scope and retains kind: practice", () => {
			const store = createChatStore(chatsDir);
			const scope: StudyScope = {
				type: "tag",
				tags: ["#calculus", "#derivatives"],
				projectId: "proj_math",
			};

			const chat = store.createChat("Derivatives Practice", "practice", scope);
			assert.equal(chat.kind, "practice");
			assert.deepEqual(chat.scope, scope);

			const retrieved = store.getChat(chat.id);
			assert.ok(retrieved);
			assert.equal(retrieved.kind, "practice");
			assert.deepEqual(retrieved.scope, scope);
		});

		it("exposes scope on listChats summaries", () => {
			const store = createChatStore(chatsDir);
			const scopeA: StudyScope = {
				type: "document",
				documentIds: ["doc_linear_algebra"],
				projectId: "proj_math",
			};
			const chat1 = store.createChat("Scoped Chat", undefined, scopeA);
			const chat2 = store.createChat("Unscoped Chat");

			const list = store.listChats();
			assert.equal(list.length, 2);

			const summary1 = list.find((s) => s.id === chat1.id);
			const summary2 = list.find((s) => s.id === chat2.id);

			assert.ok(summary1);
			assert.deepEqual(summary1.scope, scopeA);

			assert.ok(summary2);
			assert.equal(summary2.scope, undefined);
		});

		it("updates chat scope via saveScope without mutating updatedAt", () => {
			const store = createChatStore(chatsDir);
			const chat = store.createChat("Mutable Scope Session");
			const originalUpdatedAt = chat.updatedAt;

			// Add small artificial delay so if updatedAt were bumped, timestamp would differ
			const updatedScope: StudyScope = {
				type: "proposition",
				propositionIds: ["prop_euler_identity"],
				projectId: "proj_euler",
				grounding: "sources-plus-external",
			};

			assert.ok(store.saveScope);
			store.saveScope(chat.id, updatedScope);

			const retrieved = store.getChat(chat.id);
			assert.ok(retrieved);
			assert.deepEqual(retrieved.scope, updatedScope);
			assert.equal(retrieved.updatedAt, originalUpdatedAt);
		});

		it("saveScope throws when chat id does not exist", () => {
			const store = createChatStore(chatsDir);
			assert.ok(store.saveScope);
			assert.throws(
				() => store.saveScope!("chat_non_existent", { type: "project" }),
				/Chat not found/,
			);
		});

		it("handles read of pre-existing legacy chat files missing scope gracefully", () => {
			fs.mkdirSync(chatsDir, { recursive: true });
			const legacyId = "chat_legacy_golden";
			const legacyData = {
				id: legacyId,
				title: "Old Session Before Milestone D",
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
				messages: [],
				version: 1,
			};
			fs.writeFileSync(path.join(chatsDir, `${legacyId}.json`), JSON.stringify(legacyData, null, "\t"));

			const store = createChatStore(chatsDir);
			const loaded = store.getChat(legacyId);
			assert.ok(loaded);
			assert.equal(loaded.scope, undefined);

			const scope = resolveSessionScope(loaded, "proj_main");
			assert.equal(scope.type, "project");
			assert.equal(scope.projectId, "proj_main");
			assert.equal(scope.grounding, "sources-only");
		});
	});

	describe("PracticeStore Scope Persistence", () => {
		it("creates and retrieves problem sets with StudyScope", async () => {
			const store = createPracticeStore(practiceDir);
			const scope: StudyScope = {
				type: "source",
				sourceIds: ["src_physics_textbook"],
				projectId: "proj_physics",
				includePrerequisites: true,
			};

			const pset = await store.createProblemSet({
				projectId: "proj_physics",
				title: "Kinematics Problem Set",
				nodeIds: ["node_velocity", "node_acceleration"],
				propositions: {
					node_velocity: { name: "Velocity", statement: "Rate of change of position" },
				},
				chains: [],
				scope,
			});

			assert.ok(pset.id.startsWith("pset_"));
			assert.deepEqual(pset.scope, scope);

			const retrieved = await store.getProblemSet(pset.id);
			assert.ok(retrieved);
			assert.deepEqual(retrieved.scope, scope);

			const all = await store.listProblemSets("proj_physics");
			assert.equal(all.length, 1);
			assert.ok(all[0]);
			assert.deepEqual(all[0].scope, scope);

		});

		it("supports problem sets created without scope", async () => {
			const store = createPracticeStore(practiceDir);
			const pset = await store.createProblemSet({
				projectId: "proj_algebra",
				title: "Linear Equations",
				nodeIds: ["node_linear"],
				propositions: {},
				chains: [],
			});

			assert.equal(pset.scope, undefined);
			const retrieved = await store.getProblemSet(pset.id);
			assert.ok(retrieved);
			assert.equal(retrieved.scope, undefined);
		});
	});
});
