import {
	validateProjectId,
	InvalidProjectIdError,
	SourceNotFoundError,
	InvalidStudyScopeError,
	InvalidAskQueryError,
} from "@/src/core";
import {
	resolveProjectContext,
	ProjectNotFoundError,
	DocumentNotFoundError,
	ScopeResolutionError,
	askProjectSources,
} from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/projects/:id/ask
 * Grounded question answering against attached project sources and Obsidian notes.
 *
 * Status Codes:
 * - 200 OK: { answer, citations, scope, grounded, retrievalStats }
 * - 400 Bad Request: Malformed projectId, invalid JSON body, or invalid query/scope shape
 * - 404 Not Found: Unknown project, non-existent sourceId, or non-existent documentId
 * - 500 Internal Error: Unexpected server error
 */
export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;

	// 1. Fail-fast validation of projectId
	let validProjectId: string;
	try {
		validProjectId = validateProjectId(id);
	} catch (err) {
		const message = err instanceof Error ? err.message : "Invalid projectId";
		return Response.json({ error: message }, { status: 400 });
	}

	// 2. Resolve ProjectContext (verifies project existence)
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

	// 4. Execute Grounded Synthesis
	try {
		const result = await askProjectSources(context, rawBody);
		return Response.json(result, { status: 200 });
	} catch (err) {
		// 404 Not Found categories
		if (err instanceof SourceNotFoundError || err instanceof DocumentNotFoundError) {
			return Response.json({ error: err.message }, { status: 404 });
		}

		// 400 Bad Request categories
		if (
			err instanceof InvalidAskQueryError ||
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
