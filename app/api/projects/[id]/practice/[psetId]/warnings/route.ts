import {
	validateProjectId,
} from "@/src/core";
import {
	resolveProjectContext,
	ProjectNotFoundError,
	getProjectStore,
	checkDocumentRevisionWarnings,
} from "@/src/server";

export const dynamic = "force-dynamic";

async function resolveId(id: string): Promise<{ validProjectId?: string; errorResponse?: Response }> {
	if (id === "active") {
		const store = getProjectStore();
		const activeId = await store.getActiveProjectId();
		if (!activeId) {
			return { errorResponse: Response.json({ error: "No active project configured" }, { status: 404 }) };
		}
		return { validProjectId: activeId };
	}
	try {
		const validProjectId = validateProjectId(id);
		return { validProjectId };
	} catch (err) {
		const message = err instanceof Error ? err.message : "Invalid projectId";
		return { errorResponse: Response.json({ error: message }, { status: 400 }) };
	}
}

/**
 * GET /api/projects/:id/practice/:psetId/warnings
 * Evaluates document revision warnings against active document inventory and vault availability.
 */
export async function GET(
	_req: Request,
	{ params }: { params: Promise<{ id: string; psetId: string }> },
) {
	const { id, psetId } = await params;
	const { validProjectId, errorResponse } = await resolveId(id);
	if (errorResponse) return errorResponse;

	let context;
	try {
		context = await resolveProjectContext(validProjectId!);
	} catch (err) {
		if (err instanceof ProjectNotFoundError) {
			return Response.json({ error: err.message }, { status: 404 });
		}
		const message = err instanceof Error ? err.message : String(err);
		return Response.json({ error: message }, { status: 500 });
	}

	const problemSet = await context.practice.getProblemSet(psetId);
	if (!problemSet || problemSet.projectId !== validProjectId) {
		return Response.json({ error: `Problem set not found: ${psetId}` }, { status: 404 });
	}

	const warningReport = await checkDocumentRevisionWarnings(problemSet, context);
	return Response.json(warningReport, { status: 200 });
}
