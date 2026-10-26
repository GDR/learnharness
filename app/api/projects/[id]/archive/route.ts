import { getProjectStore, validateProjectId } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/projects/:id/archive
 * Archives a project workspace. Fails fast with HTTP 400 on invalid ID and HTTP 404 on missing project.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
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

	try {
		await store.archiveProject(validId);
		const project = await store.getProject(validId);
		return Response.json({ project });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return Response.json({ error: message }, { status: 500 });
	}
}
