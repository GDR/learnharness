import {
	validateProjectId,
	InvalidProjectIdError,
	SourceNotFoundError,
	InvalidStudyScopeError,
	InvalidPracticeRequestError,
} from "@/src/core";
import {
	resolveProjectContext,
	ProjectNotFoundError,
	DocumentNotFoundError,
	ScopeResolutionError,
	getProjectStore,
	createScopedPracticeSet,
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
 * GET /api/projects/:id/practice
 * Lists all practice sets belonging to the project.
 */
export async function GET(
	_req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	const { validProjectId, errorResponse } = await resolveId(id);
	if (errorResponse) return errorResponse;

	try {
		const context = await resolveProjectContext(validProjectId!);
		const problemSets = await context.practice.listProblemSets(validProjectId);
		return Response.json({ problemSets }, { status: 200 });
	} catch (err) {
		if (err instanceof ProjectNotFoundError) {
			return Response.json({ error: err.message }, { status: 404 });
		}
		const message = err instanceof Error ? err.message : String(err);
		return Response.json({ error: message }, { status: 500 });
	}
}

/**
 * POST /api/projects/:id/practice
 * Creates a scoped practice set with immutable graph snapshot and document revision baselines.
 */
export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
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

	let rawBody: unknown;
	try {
		rawBody = await req.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	try {
		const problemSet = await createScopedPracticeSet(context, rawBody);
		return Response.json({ problemSet, snapshot: problemSet.snapshot }, { status: 201 });
	} catch (err) {
		if (err instanceof SourceNotFoundError || err instanceof DocumentNotFoundError) {
			return Response.json({ error: err.message }, { status: 404 });
		}
		if (
			err instanceof InvalidPracticeRequestError ||
			err instanceof InvalidStudyScopeError ||
			err instanceof ScopeResolutionError ||
			err instanceof InvalidProjectIdError
		) {
			return Response.json({ error: err.message }, { status: 400 });
		}
		const message = err instanceof Error ? err.message : String(err);
		return Response.json({ error: message }, { status: 500 });
	}
}
