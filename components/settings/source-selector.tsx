"use client";

import { useEffect, useState, useCallback } from "react";
import { DEFAULT_SOURCE_EXCLUDE, type ProjectSource, type Vault } from "@/src/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Extracts a logical subfolder rootPath from a ProjectSource,
 * either from an explicit rootPath property or by inspecting include glob prefixes.
 */
export function extractSourceRootPath(source: ProjectSource): string {
	if ((source as { rootPath?: string }).rootPath) {
		return (source as { rootPath?: string }).rootPath!.replace(/\\/g, "/");
	}
	if (!source.include || source.include.length === 0) {
		return "";
	}
	const prefixes: string[] = [];
	for (const rawPattern of source.include) {
		const pattern = rawPattern.replace(/\\/g, "/");
		const match = /^([^*?]+)\/[*?]/.exec(pattern);
		if (match && match[1]) {
			prefixes.push(match[1].replace(/^\/+|\/+$/g, ""));
		} else {
			return "";
		}
	}
	const first = prefixes[0];
	if (!first) return "";
	const allSame = prefixes.every((p) => p === first);
	return allSame ? first : "";
}

export interface SourceSelectorProps {
	projectId?: string | null;
	activeProjectId?: string | null;
	initialSources?: ProjectSource[];
	initialVaults?: Vault[];
	initialFolderPath?: string;
	onSourcesChange?: () => void;
}

export function SourceSelector({
	projectId: explicitProjectId,
	activeProjectId,
	initialSources,
	initialVaults,
	initialFolderPath,
	onSourcesChange,
}: SourceSelectorProps = {}) {
	const projectId = explicitProjectId ?? activeProjectId;
	const [sources, setSources] = useState<ProjectSource[]>(initialSources ?? []);
	const [vaults, setVaults] = useState<Vault[]>(initialVaults ?? []);
	const [loading, setLoading] = useState(
		initialSources === undefined && Boolean(projectId),
	);
	const [error, setError] = useState<string | null>(null);

	// Attach source form state
	const [selectedVaultId, setSelectedVaultId] = useState<string>(
		initialVaults?.[0]?.id ?? "",
	);
	const [folderPath, setFolderPath] = useState(initialFolderPath ?? "");
	const [includeGlobs, setIncludeGlobs] = useState("**/*");
	const [excludeGlobs, setExcludeGlobs] = useState(
		DEFAULT_SOURCE_EXCLUDE.join(", "),
	);
	const [recursive, setRecursive] = useState(true);
	const [deletionPolicy, setDeletionPolicy] = useState<"retain" | "deactivate">("retain");
	const [attaching, setAttaching] = useState(false);

	const loadData = useCallback(async () => {
		if (!projectId) return;
		if (initialSources === undefined) {
			setLoading(true);
		}
		try {
			setError(null);
			const [sourcesRes, vaultsRes] = await Promise.all([
				fetch(`/api/projects/${projectId}/sources`),
				fetch("/api/vaults?check=true"),
			]);

			if (!sourcesRes.ok) throw new Error(`HTTP ${sourcesRes.status} loading sources`);
			if (!vaultsRes.ok) throw new Error(`HTTP ${vaultsRes.status} loading vaults`);

			const sourcesData = (await sourcesRes.json()) as { sources: ProjectSource[] };
			const vaultsData = (await vaultsRes.json()) as { vaults: Vault[] };

			const loadedVaults = vaultsData.vaults || [];
			setSources(sourcesData.sources || []);
			setVaults(loadedVaults);
			setSelectedVaultId((current) => current || (loadedVaults[0]?.id ?? ""));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, [projectId, initialSources]);

	useEffect(() => {
		if (projectId && initialSources === undefined) {
			void loadData();
		}
	}, [projectId, initialSources, loadData]);

	// Keep selectedVaultId in sync when vaults load
	useEffect(() => {
		if (vaults.length > 0 && (!selectedVaultId || !vaults.some((v) => v.id === selectedVaultId))) {
			setSelectedVaultId(vaults[0]!.id);
		}
	}, [vaults, selectedVaultId]);

	const handleToggleEnabled = async (source: ProjectSource) => {
		if (!projectId) return;
		setError(null);
		try {
			const res = await fetch(`/api/projects/${projectId}/sources/${source.id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ enabled: !source.enabled }),
			});
			if (!res.ok) {
				const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(errBody?.error || `HTTP ${res.status}`);
			}
			const data = (await res.json()) as { source: ProjectSource };
			setSources((prev) => prev.map((s) => (s.id === data.source.id ? data.source : s)));
			if (onSourcesChange) onSourcesChange();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const handleDetachSource = async (sourceId: string) => {
		if (!projectId) return;
		if (
			typeof window !== "undefined" &&
			window.confirm &&
			!window.confirm("Are you sure you want to detach this source from the project workspace?")
		) {
			return;
		}
		setError(null);
		try {
			const res = await fetch(`/api/projects/${projectId}/sources/${sourceId}`, {
				method: "DELETE",
			});
			if (!res.ok) {
				const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(errBody?.error || `HTTP ${res.status}`);
			}
			setSources((prev) => prev.filter((s) => s.id !== sourceId));
			if (onSourcesChange) onSourcesChange();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const handleAttachSource = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!projectId || !selectedVaultId) return;

		const normalizedFolder = folderPath.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
		const cleanFolder = normalizedFolder.replace(/^\/+|\/+$/g, "");
		const rawIncludes = includeGlobs
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		const effectiveIncludesBase = rawIncludes.length > 0 ? rawIncludes : ["**/*"];

		const finalIncludes = cleanFolder
			? effectiveIncludesBase.map((pattern) =>
					pattern.startsWith(cleanFolder + "/") || pattern === cleanFolder
						? pattern
						: `${cleanFolder}/${pattern}`,
				)
			: effectiveIncludesBase;

		const rawExcludes = excludeGlobs
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		const finalExcludes =
			rawExcludes.length > 0 ? rawExcludes : [...DEFAULT_SOURCE_EXCLUDE];

		setAttaching(true);
		setError(null);
		try {
			const res = await fetch(`/api/projects/${projectId}/sources`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					vaultId: selectedVaultId,
					include: finalIncludes,
					exclude: finalExcludes,
					recursive,
					deletionPolicy,
				}),
			});
			if (!res.ok) {
				const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(errBody?.error || `HTTP ${res.status}`);
			}
			const data = (await res.json()) as { source: ProjectSource };
			setSources((prev) => [...prev, data.source]);
			setFolderPath("");
			setIncludeGlobs("**/*");
			setExcludeGlobs(DEFAULT_SOURCE_EXCLUDE.join(", "));
			if (onSourcesChange) onSourcesChange();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setAttaching(false);
		}
	};

	const selectedVault = vaults.find((v) => v.id === selectedVaultId);
	const vaultDisplayName = selectedVault ? selectedVault.displayName : (selectedVaultId || "vault");
	const normalizedFolderPreview = folderPath.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
	const cleanFolderPreview = normalizedFolderPreview.replace(/^\/+|\/+$/g, "");
	const livePathPreview = cleanFolderPreview
		? `${vaultDisplayName}/${cleanFolderPreview}/**`
		: `${vaultDisplayName}/**`;

	return (
		<div className="mt-4 border-t border-border/60 pt-4" data-testid="source-selector">
			<div className="mb-3 flex items-center justify-between">
				<p className="text-xs uppercase tracking-widest text-muted-foreground font-medium">
					Attached Obsidian Sources
				</p>
			</div>

			{error && (
				<p
					role="alert"
					data-testid="sources-error"
					className="mb-3 rounded-sm border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-500"
				>
					{error}
				</p>
			)}

			{loading && (
				<p data-testid="sources-loading" className="text-xs text-muted-foreground">
					Loading sources…
				</p>
			)}

			{!loading && sources.length === 0 && (
				<p data-testid="sources-empty" className="mb-3 text-xs text-muted-foreground">
					No sources attached to this project workspace.
				</p>
			)}

			{!loading && sources.length > 0 && (
				<div data-testid="sources-list" className="mb-4 flex flex-col gap-2">
					{sources.map((source) => {
						const vault = vaults.find((v) => v.id === source.vaultId);
						const vaultName = vault ? vault.displayName : source.vaultId;
						const isAvailable = vault
							? vault.bindings.some((b) => b.status === "available")
							: false;
						const availabilityStatus = isAvailable ? "available" : "unavailable";
						const rootPath = extractSourceRootPath(source);
						const pathPreview = rootPath
							? `${vaultName} / ${rootPath}`
							: `${vaultName} (Entire Vault)`;
						const docCount =
							(source as { documentCount?: number }).documentCount ?? 0;

						return (
							<div
								key={source.id}
								data-testid={`source-row-${source.id}`}
								className="flex flex-col gap-2 rounded-md border border-border/60 bg-background/50 p-3 text-xs"
							>
								<div className="flex items-start justify-between gap-2">
									<div className="flex flex-col gap-1">
										<div className="flex flex-wrap items-center gap-1.5">
											<span
												data-testid={`source-vault-name-${source.id}`}
												className="font-medium text-foreground"
											>
												{vaultName}
											</span>
											<span
												data-testid={`source-availability-${source.id}`}
												className={cn(
													"rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider font-medium",
													isAvailable
														? "border border-emerald-500/20 bg-emerald-500/10 text-emerald-500"
														: "border border-red-500/20 bg-red-500/10 text-red-500",
												)}
											>
												{availabilityStatus}
											</span>
											<span
												data-testid={`source-status-enabled-${source.id}`}
												className={cn(
													"rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider",
													source.enabled
														? "bg-accent text-foreground"
														: "bg-muted text-muted-foreground",
												)}
											>
												{source.enabled ? "enabled" : "disabled"}
											</span>
											<span
												data-testid={`source-status-recursive-${source.id}`}
												className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground"
											>
												{source.recursive ? "recursive" : "shallow"}
											</span>
											<span
												data-testid={`source-status-sync-${source.id}`}
												className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground"
											>
												{source.syncMode === "automatic" ? "watch" : source.syncMode}
											</span>
											<span
												data-testid={`source-status-deletion-${source.id}`}
												className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground"
											>
												{source.deletionPolicy}
											</span>
										</div>

										<div className="flex items-center gap-2 text-muted-foreground">
											<span
												data-testid={`source-path-preview-${source.id}`}
												className="font-mono text-[11px]"
											>
												{pathPreview}
											</span>
											<span>•</span>
											<span
												data-testid={`source-doc-count-${source.id}`}
												className="text-[11px]"
											>
												{docCount} documents
											</span>
										</div>
									</div>

									<div className="flex shrink-0 items-center gap-1.5">
										<Button
											variant="outline"
											size="sm"
											data-testid={`btn-toggle-source-${source.id}`}
											onClick={() => void handleToggleEnabled(source)}
											className="h-6 px-2 text-[11px]"
										>
											{source.enabled ? "Disable" : "Enable"}
										</Button>
										<Button
											variant="ghost"
											size="sm"
											data-testid={`btn-detach-source-${source.id}`}
											onClick={() => void handleDetachSource(source.id)}
											className="h-6 px-2 text-[11px] text-red-500 hover:bg-red-500/10 hover:text-red-600"
										>
											Detach
										</Button>
									</div>
								</div>

								<div
									data-testid={`source-globs-${source.id}`}
									className="flex flex-col gap-0.5 font-mono text-[11px] text-muted-foreground/80"
								>
									<span>
										Include: {source.include && source.include.length > 0 ? source.include.join(", ") : "**/*"}
									</span>
									<span>
										Exclude: {source.exclude && source.exclude.length > 0 ? source.exclude.join(", ") : "none"}
									</span>
								</div>
							</div>
						);
					})}
				</div>
			)}

			<div data-testid="attach-source-form-container" className="mt-3 border-t border-border/40 pt-3">
				<p className="mb-2 text-xs uppercase tracking-widest text-muted-foreground font-medium">
					Attach New Source
				</p>
				{vaults.length === 0 ? (
					<p data-testid="no-vaults-notice" className="text-xs text-muted-foreground">
						No Obsidian vaults registered. Add a vault in Vault Settings.
					</p>
				) : (
					<form
						onSubmit={(e) => void handleAttachSource(e)}
						className="flex flex-col gap-3"
						data-testid="form-attach-source"
					>
						<div className="flex flex-col gap-1">
							<label className="text-xs font-medium text-foreground">Obsidian Vault</label>
							<select
								value={selectedVaultId}
								onChange={(e) => setSelectedVaultId(e.target.value)}
								aria-label="Select Vault"
								data-testid="select-vault"
								className="h-7 rounded-sm border border-border bg-background px-1.5 font-ui text-xs text-foreground outline-none"
							>
								{vaults.map((v) => (
									<option key={v.id} value={v.id}>
										{v.displayName} {v.bindings?.[0]?.rootPath ? `(${v.bindings[0].rootPath})` : ""}
									</option>
								))}
							</select>
						</div>

						<div className="flex flex-col gap-1">
							<label className="text-xs font-medium text-foreground">Folder Path</label>
							<Input
								value={folderPath}
								onChange={(e) => setFolderPath(e.target.value)}
								placeholder="Subfolder inside vault (e.g. Physics) or empty for entire vault"
								aria-label="Folder Path"
								data-testid="input-source-path"
								className="h-7 text-xs"
							/>
							<div className="font-mono text-[11px] text-muted-foreground">
								Preview: <span data-testid="source-path-preview">{livePathPreview}</span>
							</div>
						</div>

						<div className="grid grid-cols-2 gap-2">
							<div className="flex flex-col gap-1">
								<label className="text-xs font-medium text-foreground">Include Globs</label>
								<Input
									value={includeGlobs}
									onChange={(e) => setIncludeGlobs(e.target.value)}
									placeholder="**/*"
									aria-label="Include Globs"
									data-testid="input-include-globs"
									className="h-7 text-xs"
								/>
							</div>
							<div className="flex flex-col gap-1">
								<label className="text-xs font-medium text-foreground">Exclude Globs</label>
								<Input
									value={excludeGlobs}
									onChange={(e) => setExcludeGlobs(e.target.value)}
									placeholder=".obsidian/**, .trash/**, .git/**, node_modules/**"
									aria-label="Exclude Globs"
									data-testid="input-exclude-globs"
									className="h-7 text-xs"
								/>
							</div>
						</div>

						<div className="flex items-center justify-between gap-4 py-1">
							<label className="flex cursor-pointer items-center gap-2 text-xs text-foreground">
								<input
									type="checkbox"
									checked={recursive}
									onChange={(e) => setRecursive(e.target.checked)}
									aria-label="Recursive"
									data-testid="checkbox-recursive"
									className="rounded border-border text-primary"
								/>
								<span>Recursive</span>
							</label>

							<div className="flex items-center gap-2">
								<label className="text-xs text-muted-foreground">Deletion Policy:</label>
								<select
									value={deletionPolicy}
									onChange={(e) =>
										setDeletionPolicy(e.target.value as "retain" | "deactivate")
									}
									aria-label="Deletion Policy"
									data-testid="select-deletion-policy"
									className="h-7 rounded-sm border border-border bg-background px-1.5 font-ui text-xs text-foreground outline-none"
								>
									<option value="retain">Retain</option>
									<option value="deactivate">Deactivate</option>
								</select>
							</div>
						</div>

						<div className="flex justify-end pt-1">
							<Button
								type="submit"
								size="sm"
								disabled={!selectedVaultId || attaching}
								data-testid="btn-attach-source"
								className="h-7 text-xs"
							>
								{attaching ? "Attaching…" : "Attach Source"}
							</Button>
						</div>
					</form>
				)}
			</div>
		</div>
	);
}
