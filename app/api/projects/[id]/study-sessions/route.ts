import {
	validateProjectId,
	InvalidProjectIdError,
	SourceNotFoundError,
	InvalidStudyScopeError,
	InvalidStudySessionError,
} from "@/src/core";
import {
	resolveProjectContext,
	ProjectNotFoundError,
	DocumentNotFoundError,
	ScopeResolutionError,
	getProjectStore,
	createStudySession,
} from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/projects/:id/study-sessions
 * Creates a scoped study session with an immutable graph snapshot,
 * configured for Prober and Teacher adaptive learning.
 *
 * Supports both explicit project IDs and "/api/projects/active/study-sessions".
 */
export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;

	// 1. Resolve & Validate Project ID
	let validProjectId: string;
	if (id === "active") {
		const store = getProjectStore();
		const activeId = await store.getActiveProjectId();
		if (!activeId) {
			return Response.json({ error: "No active project configured" }, { status: 404 });
		}
		validProjectId = activeId;
	} else {
		try {
			validProjectId = validateProjectId(id);
		} catch (err) {
			const message = err instanceof Error ? err.message : "Invalid projectId";
			return Response.json({ error: message }, { status: 400 });
		}
	}

	// 2. Resolve ProjectContext
	let context;
	try {
		context = await resolveProjectContext(validProjectId);
	} catch (err) {
		if (err instanceof ProjectNotFoundError) {
			return Response.json({ error: err.message }, { status: 404 });
		}
		const message = err instanceof Error ? err.message : String(err);
		return Response.json({ error: message }, { status: 500 });
	}

	// 3. Parse JSON Body
	let rawBody: unknown;
	try {
		rawBody = await req.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	// 4. Create Scoped Study Session
	try {
		const result = await createStudySession(context, rawBody);
		return Response.json(result, { status: 201 });
	} catch (err) {
		// 404 Not Found
		if (err instanceof SourceNotFoundError || err instanceof DocumentNotFoundError) {
			return Response.json({ error: err.message }, { status: 404 });
		}

		// 400 Bad Request
		if (
			err instanceof InvalidStudySessionError ||
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

/**
 * GET /api/projects/:id/study-sessions
 * Lists all active study sessions in the project.
 */
export async function GET(
	_req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	let validProjectId: string;
	if (id === "active") {
		const store = getProjectStore();
		const activeId = await store.getActiveProjectId();
		if (!activeId) return Response.json({ error: "No active project configured" }, { status: 404 });
		validProjectId = activeId;
	} else {
		try {
			validProjectId = validateProjectId(id);
		} catch (err) {
			return Response.json({ error: err instanceof Error ? err.message : "Invalid projectId" }, { status: 400 });
		}
	}

	try {
		const context = await resolveProjectContext(validProjectId);
		const allChats = context.chats.listChats();
		// Return sessions that possess an explicit study scope
		const studySessions = allChats.filter((c) => c.scope !== undefined);
		return Response.json({ sessions: studySessions });
	} catch (err) {
		if (err instanceof ProjectNotFoundError) {
			return Response.json({ error: err.message }, { status: 404 });
		}
		return Response.json({ error: String(err) }, { status: 500 });
	}
}
