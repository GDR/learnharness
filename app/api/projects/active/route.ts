import { getProjectStore, validateProjectId } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/projects/active
 * Returns the currently active project and its ID.
 */
export async function GET() {
	try {
		const store = getProjectStore();
		const activeProjectId = await store.getActiveProjectId();
		const activeProject = activeProjectId ? await store.getProject(activeProjectId) : null;
		return Response.json({ activeProjectId, activeProject });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return Response.json({ error: message }, { status: 500 });
	}
}

/**
 * POST /api/projects/active
 * Sets the active project. Validates project existence and fails fast with 400/404.
 */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => null)) as { projectId?: unknown } | null;
	if (!body || typeof body !== "object" || typeof body.projectId !== "string") {
		return Response.json({ error: "projectId must be a non-empty string" }, { status: 400 });
	}

	let validId: string;
	try {
		validId = validateProjectId(body.projectId);
	} catch (err) {
		const message = err instanceof Error ? err.message : "Invalid projectId";
		return Response.json({ error: message }, { status: 400 });
	}

	const store = getProjectStore();
	const existing = await store.getProject(validId);
	if (!existing) {
		return Response.json({ error: `Project not found: ${validId}` }, { status: 404 });
	}

	try {
		await store.setActiveProjectId(validId);
		return Response.json({ ok: true, activeProjectId: validId, activeProject: existing });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return Response.json({ error: message }, { status: 400 });
	}
}
