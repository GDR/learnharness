/**
 * Server Vault Management & Safety Invariants.
 *
 * Implements server-side helpers for Obsidian vault operations:
 * querying attached project sources, safe vault removal with orphan prevention,
 * and device availability resolution.
 */

import type { VaultId } from "../core/contracts/project.ts";
import { validateVaultId, VaultNotFoundError } from "../core/contracts/project.ts";
import type { VaultRegistry, ProjectStore } from "../core/ports.ts";
import { getVaultRegistry } from "../store/vaults.ts";
import { getProjectStore, resolveProjectContext, createProjectStore } from "./projects.ts";

export interface AttachedProjectInfo {
	projectId: string;
	projectName: string;
	sourceCount: number;
}

/**
 * Discovers all projects across the workspace that currently have one or more
 * sources attached to the specified vault.
 */
export async function findVaultAttachedProjects(
	vaultId: VaultId,
	options?: { dataDir?: string; projectStore?: ProjectStore },
): Promise<AttachedProjectInfo[]> {
	const validId = validateVaultId(vaultId);
	const projectStore = options?.projectStore ?? (options?.dataDir ? createProjectStore(options.dataDir) : getProjectStore());
	const projects = await projectStore.listProjects();
	const attached: AttachedProjectInfo[] = [];

	for (const project of projects) {
		try {
			const context = await resolveProjectContext(project.id, options);
			const sources = await context.sources.listSources(project.id);
			const matchingSources = sources.filter((s) => s.vaultId === validId);
			if (matchingSources.length > 0) {
				attached.push({
					projectId: project.id,
					projectName: project.name,
					sourceCount: matchingSources.length,
				});
			}
		} catch {
			// Skip projects with unresolvable contexts
		}
	}

	return attached;
}

export class VaultInUseError extends Error {
	readonly status = 409;
	readonly vaultId: string;
	readonly attachedProjects: AttachedProjectInfo[];

	constructor(vaultId: string, vaultName: string, attachedProjects: AttachedProjectInfo[]) {
		const projectNames = attachedProjects.map((a) => `"${a.projectName}" (${a.projectId})`).join(", ");
		super(
			`Cannot delete vault "${vaultName}" (${vaultId}): currently in use by attached sources in project(s): ${projectNames}. Use force=true to detach and delete.`,
		);
		this.name = "VaultInUseError";
		this.vaultId = vaultId;
		this.attachedProjects = attachedProjects;
	}
}

/**
 * Safely deletes a vault from the VaultRegistry.
 * Enforces fail-fast 409 Conflict if active project sources reference this vault,
 * unless options.force is set to true (which cleanly detaches the sources first).
 */
export async function deleteVaultSafely(
	vaultId: VaultId,
	options?: { force?: boolean; dataDir?: string; vaultRegistry?: VaultRegistry; projectStore?: ProjectStore },
): Promise<{ ok: boolean; detachedCount: number; attachedProjects?: AttachedProjectInfo[] }> {
	const validId = validateVaultId(vaultId);
	const registry = options?.vaultRegistry ?? getVaultRegistry(options?.dataDir);
	const existing = await registry.getVault(validId);
	if (!existing) {
		throw new VaultNotFoundError(validId);
	}

	const attached = await findVaultAttachedProjects(validId, options);
	if (attached.length > 0 && !options?.force) {
		throw new VaultInUseError(validId, existing.displayName, attached);
	}

	let detachedCount = 0;
	if (attached.length > 0 && options?.force) {
		for (const att of attached) {
			try {
				const context = await resolveProjectContext(att.projectId, options);
				const sources = await context.sources.listSources(att.projectId);
				const matching = sources.filter((s) => s.vaultId === validId);
				for (const source of matching) {
					await context.sources.removeSource(source.id);
					detachedCount++;
				}
			} catch {
				// Continue detaching from remaining projects
			}
		}
	}

	const deleted = await registry.deleteVault(validId);
	return { ok: deleted, detachedCount, attachedProjects: attached };
}
