/**
 * VaultRegistry — file-backed implementation of the VaultRegistry port.
 *
 * Manages global Obsidian vault registrations and device bindings in
 * data/global/vaults.json using crash-safe POSIX atomic writes (writeAtomicJson).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import crypto from "node:crypto";
import { PATHS } from "../../config.ts";
import type { VaultRegistry } from "../core/ports.ts";
import {
	type Vault,
	type VaultId,
	type VaultBinding,
	vaultSchema,
	vaultBindingSchema,
} from "../core/contracts/project.ts";
import { writeAtomicJson } from "../core/fs-atomic.ts";

export function createVaultRegistry(customDataDir?: string): VaultRegistry {
	const dataDir = customDataDir ? path.resolve(customDataDir) : PATHS.data;
	const globalDir = path.join(dataDir, "global");
	const vaultsFile = path.join(globalDir, "vaults.json");

	let writeQueue = Promise.resolve();
	function withLock<T>(fn: () => Promise<T>): Promise<T> {
		const next = writeQueue.then(fn, fn);
		writeQueue = next.then(() => {}, () => {});
		return next;
	}

	async function readVaultsRecord(): Promise<Record<VaultId, Vault>> {
		try {
			if (!fs.existsSync(vaultsFile)) return {};
			const raw = await fs.promises.readFile(vaultsFile, "utf-8");
			const parsed = JSON.parse(raw);
			return typeof parsed === "object" && parsed !== null ? parsed : {};
		} catch {
			return {};
		}
	}

	async function writeVaultsRecord(record: Record<VaultId, Vault>): Promise<void> {
		fs.mkdirSync(globalDir, { recursive: true });
		await writeAtomicJson(vaultsFile, record);
	}

	async function listVaults(): Promise<Vault[]> {
		const vaults = await readVaultsRecord();
		return Object.values(vaults);
	}

	async function getVault(id: VaultId): Promise<Vault | null> {
		const vaults = await readVaultsRecord();
		return vaults[id] ?? null;
	}

	async function registerVault(input: Omit<Vault, "id"> & { id?: VaultId }): Promise<Vault> {
		return withLock(async () => {
			if (!input.displayName || typeof input.displayName !== "string" || !input.displayName.trim()) {
				throw new Error("displayName cannot be empty");
			}
			const id: VaultId = input.id ? input.id.trim() : `vault_${crypto.randomUUID().slice(0, 8)}`;
			const vault: Vault = {
				id,
				displayName: input.displayName.trim(),
				kind: "obsidian",
				bindings: (input.bindings || []).map((b) => ({
					deviceId: b.deviceId ? b.deviceId.trim() : "local",
					rootPath: path.resolve(b.rootPath),
					status:
						b.status ??
						(() => {
							try {
								return fs.existsSync(b.rootPath) && fs.statSync(b.rootPath).isDirectory()
									? "available"
									: "unavailable";
							} catch {
								return "unavailable";
							}
						})(),
				})),
			};

			vaultSchema.parse(vault);

			const vaults = await readVaultsRecord();
			if (vaults[id]) {
				throw new Error(`Vault with id "${id}" already exists`);
			}

			vaults[id] = vault;
			await writeVaultsRecord(vaults);
			return vault;
		});
	}

	async function updateBinding(vaultId: VaultId, binding: VaultBinding): Promise<Vault> {
		return withLock(async () => {
			const normalizedBinding: VaultBinding = {
				deviceId: binding.deviceId.trim(),
				rootPath: path.resolve(binding.rootPath),
				status: binding.status,
			};
			vaultBindingSchema.parse(normalizedBinding);

			const vaults = await readVaultsRecord();
			const vault = vaults[vaultId];
			if (!vault) {
				throw new Error(`Vault "${vaultId}" not found`);
			}

			const idx = vault.bindings.findIndex((b) => b.deviceId === normalizedBinding.deviceId);
			if (idx >= 0) {
				vault.bindings[idx] = normalizedBinding;
			} else {
				vault.bindings.push(normalizedBinding);
			}

			vaultSchema.parse(vault);
			await writeVaultsRecord(vaults);
			return vault;
		});
	}

	async function updateVault(
		id: VaultId,
		patch: { displayName?: string; bindings?: VaultBinding[] },
	): Promise<Vault> {
		return withLock(async () => {
			const vaults = await readVaultsRecord();
			const vault = vaults[id];
			if (!vault) {
				throw new Error(`Vault "${id}" not found`);
			}

			if (patch.displayName !== undefined) {
				const trimmed = patch.displayName.trim();
				if (!trimmed) {
					throw new Error("displayName cannot be empty");
				}
				vault.displayName = trimmed;
			}

			if (patch.bindings !== undefined) {
				vault.bindings = patch.bindings.map((b) => {
					const normalized: VaultBinding = {
						deviceId: b.deviceId ? b.deviceId.trim() : "local",
						rootPath: path.resolve(b.rootPath),
						status:
							b.status ??
							(() => {
								try {
									return fs.existsSync(b.rootPath) && fs.statSync(b.rootPath).isDirectory()
										? "available"
										: "unavailable";
								} catch {
									return "unavailable";
								}
							})(),
					};
					vaultBindingSchema.parse(normalized);
					return normalized;
				});
			}

			vaultSchema.parse(vault);
			await writeVaultsRecord(vaults);
			return vault;
		});
	}

	async function checkVaultAvailability(id: VaultId): Promise<Vault | null> {
		return withLock(async () => {
			const vaults = await readVaultsRecord();
			const vault = vaults[id];
			if (!vault) return null;

			let modified = false;
			for (const binding of vault.bindings) {
				let isDir = false;
				try {
					isDir = fs.existsSync(binding.rootPath) && fs.statSync(binding.rootPath).isDirectory();
				} catch {
					isDir = false;
				}
				const newStatus = isDir ? "available" : "unavailable";
				if (binding.status !== newStatus) {
					binding.status = newStatus;
					modified = true;
				}
			}

			if (modified) {
				await writeVaultsRecord(vaults);
			}
			return vault;
		});
	}

	async function checkAllVaultsAvailability(): Promise<Vault[]> {
		return withLock(async () => {
			const vaults = await readVaultsRecord();
			let modified = false;
			for (const vault of Object.values(vaults)) {
				for (const binding of vault.bindings) {
					let isDir = false;
					try {
						isDir = fs.existsSync(binding.rootPath) && fs.statSync(binding.rootPath).isDirectory();
					} catch {
						isDir = false;
					}
					const newStatus = isDir ? "available" : "unavailable";
					if (binding.status !== newStatus) {
						binding.status = newStatus;
						modified = true;
					}
				}
			}
			if (modified) {
				await writeVaultsRecord(vaults);
			}
			return Object.values(vaults);
		});
	}

	async function deleteVault(id: VaultId): Promise<boolean> {
		return withLock(async () => {
			const vaults = await readVaultsRecord();
			if (!vaults[id]) return false;
			delete vaults[id];
			await writeVaultsRecord(vaults);
			return true;
		});
	}

	return {
		dataDir,
		listVaults,
		getVault,
		registerVault,
		updateBinding,
		updateVault,
		deleteVault,
		checkVaultAvailability,
		checkAllVaultsAvailability,
	};
}

let defaultVaultRegistry: VaultRegistry | null = null;

export function getVaultRegistry(customDataDir?: string): VaultRegistry {
	if (customDataDir) return createVaultRegistry(customDataDir);
	return (defaultVaultRegistry ??= createVaultRegistry());
}

export function setVaultRegistry(registry: VaultRegistry | null): void {
	defaultVaultRegistry = registry;
}
