"use client";

import { useEffect, useState, useCallback } from "react";
import type { Project, ProjectSettings } from "@/src/core";
import { SettingsSection, SettingsGroup, SettingsRow, ThinSelect, CommitInput } from "./controls.tsx";
import { notifyProjectChanged, useProjectChanged } from "@/components/settings-signal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function ProjectSection() {
	const [projects, setProjects] = useState<Project[]>([]);
	const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	// Create project draft
	const [newName, setNewName] = useState("");
	const [newDescription, setNewDescription] = useState("");
	const [creating, setCreating] = useState(false);

	const loadProjects = useCallback(async () => {
		try {
			const res = await fetch("/api/projects");
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as { projects: Project[]; activeProjectId: string | null };
			setProjects(data.projects || []);
			setActiveProjectId(data.activeProjectId || null);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void loadProjects();
	}, [loadProjects]);

	useProjectChanged(() => {
		void loadProjects();
	});

	const activeProject = projects.find((p) => p.id === activeProjectId);

	const switchActiveProject = async (projectId: string) => {
		try {
			const res = await fetch("/api/projects/active", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ projectId }),
			});
			if (!res.ok) throw new Error(`Failed to activate project: HTTP ${res.status}`);
			setActiveProjectId(projectId);
			notifyProjectChanged(projectId);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const patchActiveProject = async (patch: Partial<Omit<Project, "id" | "createdAt">>) => {
		if (!activeProjectId) return;
		try {
			const res = await fetch(`/api/projects/${activeProjectId}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(patch),
			});
			if (!res.ok) throw new Error(`Failed to update project: HTTP ${res.status}`);
			const data = (await res.json()) as { project: Project };
			setProjects((prev) => prev.map((p) => (p.id === data.project.id ? data.project : p)));
			notifyProjectChanged(activeProjectId);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const archiveProject = async (projectId: string) => {
		try {
			const res = await fetch(`/api/projects/${projectId}/archive`, { method: "POST" });
			if (!res.ok) throw new Error(`Failed to archive project: HTTP ${res.status}`);
			const data = (await res.json()) as { project: Project };
			setProjects((prev) => prev.map((p) => (p.id === data.project.id ? data.project : p)));
			notifyProjectChanged(projectId);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const deleteProject = async (projectId: string) => {
		if (!window.confirm("Are you sure you want to permanently delete this project workspace?")) {
			return;
		}
		try {
			const res = await fetch(`/api/projects/${projectId}`, { method: "DELETE" });
			if (!res.ok) throw new Error(`Failed to delete project: HTTP ${res.status}`);
			await loadProjects();
			notifyProjectChanged();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const handleCreateProject = async (e: React.FormEvent) => {
		e.preventDefault();
		const trimmedName = newName.trim();
		if (!trimmedName) return;
		setCreating(true);
		try {
			const res = await fetch("/api/projects", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: trimmedName,
					...(newDescription.trim() ? { description: newDescription.trim() } : {}),
				}),
			});
			if (!res.ok) {
				const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(errBody?.error || `HTTP ${res.status}`);
			}
			const data = (await res.json()) as { project: Project };
			setNewName("");
			setNewDescription("");
			await loadProjects();
			notifyProjectChanged(data.project.id);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setCreating(false);
		}
	};

	return (
		<SettingsSection
			title="Projects"
			hint="Multi-project workspace isolation and settings"
			testid="section-projects"
		>
			{error && (
				<p
					role="alert"
					className="rounded-sm border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-500"
					data-testid="projects-error"
				>
					{error}
				</p>
			)}

			{loading && <p className="text-xs text-muted-foreground">Loading projects…</p>}

			{!loading && activeProject && (
				<SettingsGroup label="Active Workspace Settings" testid="group-active-project">
					<SettingsRow
						label="Workspace Name"
						hint={`ID: ${activeProject.id}`}
						testid="row-project-name"
					>
						<CommitInput
							value={activeProject.name}
							ariaLabel="Workspace Name"
							testid="input-project-name"
							onCommit={(next) => void patchActiveProject({ name: next })}
						/>
					</SettingsRow>

					<SettingsRow
						label="Description"
						hint="Optional notes on the focus of this workspace"
						testid="row-project-description"
					>
						<CommitInput
							value={activeProject.description ?? ""}
							placeholder="None"
							ariaLabel="Workspace Description"
							testid="input-project-description"
							onCommit={(next) => void patchActiveProject({ description: next })}
						/>
					</SettingsRow>

					<SettingsRow
						label="Default Study Scope"
						hint="How retrieval scopes sources during questions and study sessions"
						testid="row-project-scope"
					>
						<ThinSelect
							value={activeProject.settings?.defaultStudyScope ?? "all"}
							ariaLabel="Default Study Scope"
							testid="select-project-scope"
							onChange={(next) =>
								void patchActiveProject({
									settings: {
										...activeProject.settings,
										defaultStudyScope: next as ProjectSettings["defaultStudyScope"],
									},
								})
							}
						>
							<option value="all">All Sources (Default)</option>
							<option value="manual">Manual Scope Selection</option>
						</ThinSelect>
					</SettingsRow>

					<SettingsRow
						label="Source Grounding"
						hint="Strict requires source evidence; Assisted permits general model knowledge"
						testid="row-project-grounding"
					>
						<ThinSelect
							value={activeProject.settings?.sourceGrounding ?? "strict"}
							ariaLabel="Source Grounding"
							testid="select-project-grounding"
							onChange={(next) =>
								void patchActiveProject({
									settings: {
										...activeProject.settings,
										sourceGrounding: next as ProjectSettings["sourceGrounding"],
									},
								})
							}
						>
							<option value="strict">Strict (Source-Grounded)</option>
							<option value="assisted">Assisted (Knowledge Fallback)</option>
						</ThinSelect>
					</SettingsRow>
				</SettingsGroup>
			)}

			<SettingsGroup label="All Workspaces" testid="group-all-projects">
				<div className="flex flex-col gap-2" data-testid="project-list">
					{projects.map((p) => {
						const isActive = p.id === activeProjectId;
						return (
							<div
								key={p.id}
								data-testid={`project-row-${p.id}`}
								className="flex items-center justify-between rounded-md border border-border/60 bg-background/50 px-3 py-2 text-xs"
							>
								<div className="flex flex-col gap-0.5">
									<div className="flex items-center gap-2">
										<span className="font-medium text-foreground">{p.name}</span>
										{isActive && (
											<span
												data-testid="active-badge"
												className="rounded bg-accent px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-foreground"
											>
												Active
											</span>
										)}
										{p.status === "archived" && (
											<span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
												Archived
											</span>
										)}
									</div>
									{p.description && (
										<span className="text-muted-foreground">{p.description}</span>
									)}
								</div>

								<div className="flex items-center gap-2">
									{!isActive && p.status === "active" && (
										<Button
											variant="outline"
											size="sm"
											data-testid={`btn-activate-${p.id}`}
											onClick={() => void switchActiveProject(p.id)}
											className="h-6 px-2 text-[11px]"
										>
											Activate
										</Button>
									)}
									{p.status === "active" && p.id !== "proj_default" && (
										<Button
											variant="ghost"
											size="sm"
											data-testid={`btn-archive-${p.id}`}
											onClick={() => void archiveProject(p.id)}
											className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground"
										>
											Archive
										</Button>
									)}
									{p.id !== "proj_default" && (
										<Button
											variant="ghost"
											size="sm"
											data-testid={`btn-delete-${p.id}`}
											onClick={() => void deleteProject(p.id)}
											className="h-6 px-2 text-[11px] text-red-500 hover:bg-red-500/10 hover:text-red-600"
										>
											Delete
										</Button>
									)}
								</div>
							</div>
						);
					})}
				</div>
			</SettingsGroup>

			<SettingsGroup label="New Workspace" testid="group-create-project">
				<form onSubmit={(e) => void handleCreateProject(e)} className="flex flex-col gap-2">
					<div className="flex gap-2">
						<Input
							value={newName}
							onChange={(e) => setNewName(e.target.value)}
							placeholder="Workspace name…"
							aria-label="New workspace name"
							data-testid="input-new-project-name"
							className="h-7 text-xs"
						/>
						<Input
							value={newDescription}
							onChange={(e) => setNewDescription(e.target.value)}
							placeholder="Description (optional)…"
							aria-label="New workspace description"
							data-testid="input-new-project-description"
							className="h-7 text-xs"
						/>
						<Button
							type="submit"
							size="sm"
							disabled={!newName.trim() || creating}
							data-testid="btn-create-project"
							className="h-7 shrink-0 text-xs"
						>
							{creating ? "Creating…" : "Create"}
						</Button>
					</div>
				</form>
			</SettingsGroup>
		</SettingsSection>
	);
}
