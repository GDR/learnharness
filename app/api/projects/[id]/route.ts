import type { Project, ProjectPatch } from "@/src/core";
import { projectSettingsSchema } from "@/src/core";
import { getProjectStore, validateProjectId } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/projects/:id
 * Fetches a single project by its unique identifier.
 * Fails fast with HTTP 400 on invalid ID format and HTTP 404 on missing project.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	let validId: string;
	try {
		validId = validateProjectId(id);
	} catch (err) {
		const message = err instanceof Error ? err.message : "Invalid projectId";
		return Response.json({ error: message }, { status: 400 });
	}

	try {
		const store = getProjectStore();
		const project = await store.getProject(validId);
		if (!project) {
			return Response.json({ error: `Project not found: ${validId}` }, { status: 404 });
		}
		return Response.json({ project });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return Response.json({ error: message }, { status: 500 });
	}
}

/**
 * PATCH /api/projects/:id
 * Updates mutable fields of a project (name, description, status, settings)
 * and optionally activates it if { active: true } is passed.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	let validId: string;
	try {
		validId = validateProjectId(id);
	} catch (err) {
		const message = err instanceof Error ? err.message : "Invalid projectId";
		return Response.json({ error: message }, { status: 400 });
	}

	const store = getProjectStore();
	const existing = await store.getProject(validId);
	if (!existing) {
		return Response.json({ error: `Project not found: ${validId}` }, { status: 404 });
	}

	const body = (await req.json().catch(() => null)) as {
		name?: unknown;
		description?: unknown;
		status?: unknown;
		settings?: unknown;
		active?: unknown;
	} | null;

	if (!body || typeof body !== "object") {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	if (body.name !== undefined) {
		if (typeof body.name !== "string" || body.name.trim() === "") {
			return Response.json({ error: "Project name cannot be empty" }, { status: 400 });
		}
	}

	if (body.description !== undefined && body.description !== null && typeof body.description !== "string") {
		return Response.json({ error: "description must be a string or null" }, { status: 400 });
	}

	if (body.status !== undefined && body.status !== "active" && body.status !== "archived") {
		return Response.json({ error: 'status must be "active" or "archived"' }, { status: 400 });
	}

	if (body.settings !== undefined) {
		const parsedSettings = projectSettingsSchema.partial().safeParse(body.settings);
		if (!parsedSettings.success) {
			return Response.json(
				{ error: parsedSettings.error.issues[0]?.message ?? "Invalid project settings" },
				{ status: 400 },
			);
		}
	}

	if (body.active === true) {
		await store.setActiveProjectId(validId);
	}

	const patch: ProjectPatch = {};
	if (body.name !== undefined) patch.name = (body.name as string).trim();
	if (body.description !== undefined) {
		patch.description = body.description ? (body.description as string).trim() : undefined;
	}
	if (body.status !== undefined) patch.status = body.status as "active" | "archived";
	if (body.settings !== undefined) {
		patch.settings = body.settings as Partial<Project["settings"]>;
	}

	try {
		let project = existing;
		if (Object.keys(patch).length > 0) {
			project = await store.updateProject(validId, patch);
		}
		const activeProjectId = await store.getActiveProjectId();
		return Response.json({ project, active: activeProjectId === validId });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return Response.json({ error: message }, { status: 400 });
	}
}

/**
 * DELETE /api/projects/:id
 * Removes a project and its workspace storage. Fails fast with 404 if not found.
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	let validId: string;
	try {
		validId = validateProjectId(id);
	} catch (err) {
		const message = err instanceof Error ? err.message : "Invalid projectId";
		return Response.json({ error: message }, { status: 400 });
	}

	try {
		const store = getProjectStore();
		const deleted = await store.deleteProject(validId);
		if (!deleted) {
			return Response.json({ error: `Project not found: ${validId}` }, { status: 404 });
		}
		return Response.json({ ok: true });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return Response.json({ error: message }, { status: 500 });
	}
}
