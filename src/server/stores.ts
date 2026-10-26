/**
 * THE COMPOSITION ROOT for storage — the legacy bridge & composition root.
 *
 * During multi-project migration (Milestone A), this module instantiates default
 * project stores via resolveProjectContext(DEFAULT_PROJECT_ID) while maintaining
 * the legacy singleton interfaces (chatStore, graphStore, jobStore) to preserve
 * legacy callers during migration.
 */

import path from "node:path";
import { PATHS } from "../../config.ts";
import { DEFAULT_PROJECT_ID, type ProjectContext } from "../core/contracts/project.ts";
import { settingsStore } from "../store/settings.ts";
import { resolveSettings, type EffectiveSettings } from "../core/settings-resolution.ts";
import { chatStore } from "../store/chats.ts";
import { graphStore } from "../store/graph.ts";
import { jobStore } from "../store/jobs.ts";
import { createPracticeStore } from "../store/practice.ts";
import { createSourceStore } from "../store/sources.ts";
import { getProjectStore, resolveProjectContext } from "./projects.ts";
import type { PracticeStore, SourceStore } from "../core/ports.ts";

const defaultProjectDir = path.join(PATHS.data, "projects", DEFAULT_PROJECT_ID);
const defaultPracticeStore: PracticeStore = createPracticeStore(path.join(defaultProjectDir, "practice"));
const defaultSourceStore: SourceStore = createSourceStore(path.join(defaultProjectDir, "sources"));

let defaultProjectContext: ProjectContext | null = null;

/**
 * Instantiates and resolves default project stores via resolveProjectContext(DEFAULT_PROJECT_ID).
 */
export const defaultProjectContextPromise: Promise<ProjectContext> = (async () => {
	try {
		const pStore = getProjectStore();
		const existing = await pStore.getProject(DEFAULT_PROJECT_ID);
		if (!existing) {
			await pStore.createProject({
				id: DEFAULT_PROJECT_ID,
				name: "Default Project",
			});
		}
		const ctx = await resolveProjectContext(DEFAULT_PROJECT_ID);
		defaultProjectContext = ctx;
		return ctx;
	} catch (err) {
		console.warn(`[stores] failed to resolve default project context:`, err);
		return {
			projectId: DEFAULT_PROJECT_ID,
			chats: chatStore,
			graph: graphStore,
			jobs: jobStore,
			practice: defaultPracticeStore,
			sources: defaultSourceStore,
		};
	}
})();

export async function getDefaultProjectContext(): Promise<ProjectContext> {
	return defaultProjectContext ?? (await defaultProjectContextPromise);
}

/** The wired adapters. Satisfies core/graph.ts's GraphDeps structurally. */
export const stores = {
	chatStore,
	graphStore,
	jobStore,
	settingsStore,
	get practiceStore(): PracticeStore {
		return defaultProjectContext?.practice ?? defaultPracticeStore;
	},
	get sourceStore(): SourceStore {
		return defaultProjectContext?.sources ?? defaultSourceStore;
	},
};

export type Stores = typeof stores;

/**
 * The resolved view of the settings record (core/settings-resolution.ts):
 * every knob concrete over its factory default — EXCEPT MODELS (BYOK all
 * the way down, owner 2026-09-22): no factory pins exist, so unset model
 * slots resolve to null and per-need refusal gates fire downstream. Read
 * fresh on every call — the record is a small file and turns are rare, so
 * no caching layer (stale toggles after a settings PUT would be worse).
 */
export function effectiveSettings(): EffectiveSettings {
	return resolveSettings(settingsStore.readSettings());
}
