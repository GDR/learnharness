/**
 * Vault Identity and Discovery for LearnHarness Obsidian Bridge Plugin.
 *
 * Implements:
 * 1. Safe vault root path resolution across Electron and adapter mocks.
 * 2. Deterministic FNV-1a stable vaultId derivation matching ^[A-Za-z0-9_-]+$.
 * 3. Server registration with POST /api/vaults and idempotent 409 conflict handling.
 * 4. Per-vault registration caching in BridgeSettings.
 */

import type { ObsidianApp, VaultRegistrationPayload, VaultSummary } from "./types.ts";
import type { BridgeTransport } from "./transport.ts";
import type { LearnHarnessBridgePlugin } from "./main.ts";

export function getVaultRootPath(app?: ObsidianApp): string | undefined {
	const adapter = app?.vault?.adapter as { getBasePath?(): string; basePath?: string } | undefined;
	if (typeof adapter?.getBasePath === "function") {
		const p = adapter.getBasePath();
		if (typeof p === "string" && p.trim()) return p.trim();
	}
	if (typeof adapter?.basePath === "string" && adapter.basePath.trim()) {
		return adapter.basePath.trim();
	}
	return undefined;
}

export function computeStableVaultId(vaultName: string, rootPath?: string): string {
	const cleanSlug = (vaultName || "vault")
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 24);

	const seed = (rootPath && rootPath.trim()) ? rootPath.trim() : (vaultName || "vault");
	let hash = 0x811c9dc5;
	for (let i = 0; i < seed.length; i++) {
		hash ^= seed.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	const hexHash = (hash >>> 0).toString(16).padStart(8, "0");
	return `vault_${cleanSlug ? cleanSlug + "_" : ""}${hexHash}`;
}

export async function registerVaultWithServer(
	transport: BridgeTransport,
	payload: VaultRegistrationPayload,
): Promise<VaultSummary> {
	const res = await transport.registerVault(payload);
	return res.vault;
}

export async function ensureVaultRegistered(
	plugin: LearnHarnessBridgePlugin,
): Promise<VaultSummary> {
	const vaultName = plugin.app?.vault?.getName?.() || "DefaultVault";
	const rootPath = getVaultRootPath(plugin.app);

	// 1. If vaultId is already stored in plugin settings, verify with server
	const existingVaultId = plugin.settings.vaultId || plugin.settings.registeredVaultId;
	if (existingVaultId) {
		try {
			const res = await plugin.transport.getVault(existingVaultId);
			if (res.vault) {
				if (!plugin.settings.vaultId || !plugin.settings.registeredVaultId) {
					plugin.settings.vaultId = res.vault.id;
					plugin.settings.registeredVaultId = res.vault.id;
					await plugin.saveSettings();
				}
				return res.vault;
			}
		} catch {
			// If lookup fails or vault deleted on server, proceed to re-register
		}
	}

	// 2. Check if vault is already known on server by rootPath or displayName
	try {
		const list = await plugin.transport.listVaults();
		const matched = list.vaults.find(
			(v) =>
				(rootPath && v.bindings?.some((b) => b.rootPath === rootPath)) ||
				v.displayName === vaultName,
		);
		if (matched) {
			plugin.settings.vaultId = matched.id;
			plugin.settings.registeredVaultId = matched.id;
			await plugin.saveSettings();
			return matched;
		}
	} catch {
		// Server may be offline or listVaults failed; continue to attempt direct registration
	}

	// 3. Register fresh vault with deterministic stable ID
	const targetId = computeStableVaultId(vaultName, rootPath);
	const payload: VaultRegistrationPayload = {
		id: targetId,
		displayName: vaultName,
		path: rootPath,
		deviceId: "local",
	};

	const vault = await registerVaultWithServer(plugin.transport, payload);
	plugin.settings.vaultId = vault.id;
	plugin.settings.registeredVaultId = vault.id;
	await plugin.saveSettings();
	return vault;
}
