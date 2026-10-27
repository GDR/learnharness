import {
	validateProjectId,
	InvalidProjectIdError,
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
 * GET /api/projects/:id/practice/:psetId
 * Retrieves a single problem set. If query param `warnings=true`, evaluates document revision warnings.
 */
export async function GET(
	req: Request,
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

	const url = new URL(req.url);
	const includeWarnings = url.searchParams.get("warnings") === "true";

	if (includeWarnings && problemSet.sourceSnapshots) {
		const warningReport = await checkDocumentRevisionWarnings(problemSet, context);
		return Response.json(
			{
				problemSet: {
					...problemSet,
					warningSummary: {
						hasWarnings: warningReport.hasWarnings,
						warningCount: warningReport.warningCount,
						byDocumentId: Object.fromEntries(warningReport.warnings.map((w) => [w.documentId, w.status])),
					},
				},
				warnings: warningReport.warnings,
			},
			{ status: 200 },
		);
	}

	return Response.json({ problemSet }, { status: 200 });
}

/**
 * PATCH /api/projects/:id/practice/:psetId
 * Updates status or other fields of a practice set.
 */
export async function PATCH(
	req: Request,
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

	const existing = await context.practice.getProblemSet(psetId);
	if (!existing || existing.projectId !== validProjectId) {
		return Response.json({ error: `Problem set not found: ${psetId}` }, { status: 404 });
	}

	let patch: unknown;
	try {
		patch = await req.json();
		if (!patch || typeof patch !== "object") {
			return Response.json({ error: "Patch body must be an object" }, { status: 400 });
		}
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	const updated = await context.practice.updateProblemSet(psetId, patch as any);
	return Response.json({ problemSet: updated }, { status: 200 });
}

/**
 * DELETE /api/projects/:id/practice/:psetId
 * Deletes a practice set.
 */
export async function DELETE(
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

	const existing = await context.practice.getProblemSet(psetId);
	if (!existing || existing.projectId !== validProjectId) {
		return Response.json({ error: `Problem set not found: ${psetId}` }, { status: 404 });
	}

	await context.practice.deleteProblemSet(psetId);
	return Response.json({ deleted: true }, { status: 200 });
}
