/**
 * Server Source Management & Validation.
 *
 * Implements server-side operations and safety invariants for project sources:
 * validating project and source identifiers, resolving project contexts,
 * verifying bound vault existence in VaultRegistry, and managing source lifecycle.
 */

import {
	type ProjectId,
	type SourceId,
	type ProjectSource,
	type ProjectSourcePatch,
	validateSourceId,
	validateVaultId,
	VaultNotFoundError,
	SourceNotFoundError,
	DEFAULT_SOURCE_EXCLUDE,
	DEFAULT_SOURCE_INCLUDE,
	projectSourcePatchSchema,
} from "../core/contracts/project.ts";
import type { ProjectStore, VaultRegistry } from "../core/ports.ts";
import { resolveProjectContext, validateProjectId, InvalidProjectIdError } from "./projects.ts";
import { getVaultRegistry } from "../store/vaults.ts";
import { normalizeGlob, normalizeGlobs, type AddSourceInput } from "../store/sources.ts";


export { normalizeGlob, normalizeGlobs };

export interface ValidatedProjectSourceContext {
	context: Awaited<ReturnType<typeof resolveProjectContext>>;
	source: ProjectSource;
	validProjectId: ProjectId;
	validSourceId: SourceId;
}

/**
 * Validates project and source identifiers, resolves ProjectContext,
 * and fetches the source while enforcing cross-project isolation
 * (source must belong to the requested project).
 *
 * Throws InvalidProjectIdError / InvalidSourceIdError (HTTP 400),
 * or ProjectNotFoundError / SourceNotFoundError (HTTP 404).
 */
export async function resolveProjectSource(
	projectId: unknown,
	sourceId: unknown,
	options?: { dataDir?: string; projectStore?: ProjectStore },
): Promise<ValidatedProjectSourceContext> {
	const validProjectId = validateProjectId(projectId);
	const validSourceId = validateSourceId(sourceId);

	const context = await resolveProjectContext(validProjectId, options);
	const source = await context.sources.getSource(validSourceId);
	if (!source || source.projectId !== validProjectId) {
		throw new SourceNotFoundError(validSourceId);
	}

	return {
		context,
		source,
		validProjectId,
		validSourceId,
	};
}

/**
 * Attaches a new Obsidian vault source to a project workspace.
 * Validates project existence, verifies that the target vault exists
 * in VaultRegistry, normalizes include/exclude globs, and stores the source.
 */
export async function attachProjectSource(
	projectId: unknown,
	input: {
		vaultId: unknown;
		include?: unknown;
		exclude?: unknown;
		recursive?: unknown;
		enabled?: unknown;
		syncMode?: unknown;
		deletionPolicy?: unknown;
	},
	options?: { dataDir?: string; projectStore?: ProjectStore; vaultRegistry?: VaultRegistry },
): Promise<ProjectSource> {
	const validProjectId = validateProjectId(projectId);
	const validVaultId = validateVaultId(input.vaultId);

	const vRegistry = options?.vaultRegistry ?? getVaultRegistry(options?.dataDir);
	const vault = await vRegistry.getVault(validVaultId);
	if (!vault) {
		throw new VaultNotFoundError(validVaultId);
	}

	const context = await resolveProjectContext(validProjectId, options);

	const addInput: AddSourceInput = {
		projectId: validProjectId,
		vaultId: validVaultId,
	};

	if (input.include !== undefined) {
		if (!Array.isArray(input.include) || !input.include.every((item) => typeof item === "string")) {
			throw new Error("include must be an array of string glob patterns");
		}
		addInput.include = input.include;
	}

	if (input.exclude !== undefined) {
		if (!Array.isArray(input.exclude) || !input.exclude.every((item) => typeof item === "string")) {
			throw new Error("exclude must be an array of string glob patterns");
		}
		addInput.exclude = input.exclude;
	}

	if (input.recursive !== undefined) {
		if (typeof input.recursive !== "boolean") {
			throw new Error("recursive must be a boolean");
		}
		addInput.recursive = input.recursive;
	}

	if (input.enabled !== undefined) {
		if (typeof input.enabled !== "boolean") {
			throw new Error("enabled must be a boolean");
		}
		addInput.enabled = input.enabled;
	}

	if (input.syncMode !== undefined) {
		if (input.syncMode !== "manual" && input.syncMode !== "automatic") {
			throw new Error('syncMode must be "manual" or "automatic"');
		}
		addInput.syncMode = input.syncMode;
	}

	if (input.deletionPolicy !== undefined) {
		if (input.deletionPolicy !== "deactivate" && input.deletionPolicy !== "retain") {
			throw new Error('deletionPolicy must be "deactivate" or "retain"');
		}
		addInput.deletionPolicy = input.deletionPolicy;
	}

	const rawInclude = addInput.include ? normalizeGlobs(addInput.include) : [];
	const rawExclude = addInput.exclude ? normalizeGlobs(addInput.exclude) : [];
	const include = rawInclude.length > 0 ? rawInclude : [...DEFAULT_SOURCE_INCLUDE];
	const exclude = rawExclude.length > 0 ? rawExclude : [...DEFAULT_SOURCE_EXCLUDE];

	return await context.sources.addSource({
		projectId: validProjectId,
		vaultId: validVaultId,
		include,
		exclude,
		recursive: addInput.recursive ?? true,
		enabled: addInput.enabled ?? true,
		syncMode: addInput.syncMode ?? "manual",
		deletionPolicy: addInput.deletionPolicy ?? "deactivate",
	});
}

/**
 * Updates mutable fields of an existing project source.
 */
export async function updateProjectSource(
	projectId: unknown,
	sourceId: unknown,
	patch: ProjectSourcePatch,
	options?: { dataDir?: string; projectStore?: ProjectStore },
): Promise<ProjectSource> {
	const parsedPatch = projectSourcePatchSchema.safeParse(patch);
	if (!parsedPatch.success) {
		throw new Error(parsedPatch.error.issues[0]?.message ?? "Invalid source patch");
	}

	const { context, validSourceId } = await resolveProjectSource(projectId, sourceId, options);
	return await context.sources.updateSource(validSourceId, parsedPatch.data);
}

/**
 * Removes an attached source from a project workspace and cleans up
 * its document inventories.
 */
export async function removeProjectSource(
	projectId: unknown,
	sourceId: unknown,
	options?: { dataDir?: string; projectStore?: ProjectStore },
): Promise<{ success: true; deletedSourceId: SourceId }> {
	const { context, validSourceId } = await resolveProjectSource(projectId, sourceId, options);
	await context.sources.removeSource(validSourceId);
	return { success: true, deletedSourceId: validSourceId };
}
