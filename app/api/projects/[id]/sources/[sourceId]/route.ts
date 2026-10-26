import {
	validateProjectId,
	validateSourceId,
	InvalidProjectIdError,
	InvalidSourceIdError,
	SourceNotFoundError,
	type ProjectSourcePatch,
} from "@/src/core";
import {
	resolveProjectSource,
	updateProjectSource,
	removeProjectSource,
	ProjectNotFoundError,
} from "@/src/server";


export const dynamic = "force-dynamic";

/**
 * GET /api/projects/:id/sources/:sourceId
 * Fetches a single attached source by its sourceId.
 * Fails fast with HTTP 400 on invalid ID formats and HTTP 404 if project or source is missing.
 */
export async function GET(
	_req: Request,
	{ params }: { params: Promise<{ id: string; sourceId: string }> },
) {
	const { id, sourceId } = await params;

	try {
		const { source } = await resolveProjectSource(id, sourceId);
		return Response.json({ source });
	} catch (err) {
		if (err instanceof InvalidProjectIdError || err instanceof InvalidSourceIdError) {
			return Response.json({ error: err.message }, { status: 400 });
		}
		if (err instanceof ProjectNotFoundError || err instanceof SourceNotFoundError) {
			return Response.json({ error: err.message }, { status: 404 });
		}
		const message = err instanceof Error ? err.message : String(err);
		return Response.json({ error: message }, { status: 500 });
	}
}

/**
 * PATCH /api/projects/:id/sources/:sourceId
 * Updates mutable fields of an attached source:
 * include, exclude, recursive, enabled, syncMode, deletionPolicy.
 * Fails fast with HTTP 400 on malformed input and HTTP 404 if project or source is missing.
 */
export async function PATCH(
	req: Request,
	{ params }: { params: Promise<{ id: string; sourceId: string }> },
) {
	const { id, sourceId } = await params;

	let validProjectId: string;
	let validSourceId: string;
	try {
		validProjectId = validateProjectId(id);
		validSourceId = validateSourceId(sourceId);
	} catch (err) {
		const message = err instanceof Error ? err.message : "Invalid identifier";
		return Response.json({ error: message }, { status: 400 });
	}

	const body = (await req.json().catch(() => null)) as {
		include?: unknown;
		exclude?: unknown;
		recursive?: unknown;
		enabled?: unknown;
		syncMode?: unknown;
		deletionPolicy?: unknown;
	} | null;

	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	// Validate field types before patching
	if (body.include !== undefined) {
		if (!Array.isArray(body.include) || !body.include.every((i) => typeof i === "string")) {
			return Response.json({ error: "include must be an array of strings" }, { status: 400 });
		}
	}

	if (body.exclude !== undefined) {
		if (!Array.isArray(body.exclude) || !body.exclude.every((e) => typeof e === "string")) {
			return Response.json({ error: "exclude must be an array of strings" }, { status: 400 });
		}
	}

	if (body.recursive !== undefined && typeof body.recursive !== "boolean") {
		return Response.json({ error: "recursive must be a boolean" }, { status: 400 });
	}

	if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
		return Response.json({ error: "enabled must be a boolean" }, { status: 400 });
	}

	if (body.syncMode !== undefined && body.syncMode !== "manual" && body.syncMode !== "automatic") {
		return Response.json({ error: 'syncMode must be "manual" or "automatic"' }, { status: 400 });
	}

	if (body.deletionPolicy !== undefined && body.deletionPolicy !== "deactivate" && body.deletionPolicy !== "retain") {
		return Response.json({ error: 'deletionPolicy must be "deactivate" or "retain"' }, { status: 400 });
	}

	const patch: ProjectSourcePatch = {};
	if (body.include !== undefined) patch.include = body.include as string[];
	if (body.exclude !== undefined) patch.exclude = body.exclude as string[];
	if (body.recursive !== undefined) patch.recursive = body.recursive as boolean;
	if (body.enabled !== undefined) patch.enabled = body.enabled as boolean;
	if (body.syncMode !== undefined) patch.syncMode = body.syncMode as "manual" | "automatic";
	if (body.deletionPolicy !== undefined) patch.deletionPolicy = body.deletionPolicy as "deactivate" | "retain";

	try {
		const source = await updateProjectSource(validProjectId, validSourceId, patch);
		return Response.json({ source });
	} catch (err) {
		if (err instanceof InvalidProjectIdError || err instanceof InvalidSourceIdError) {
			return Response.json({ error: err.message }, { status: 400 });
		}
		if (err instanceof ProjectNotFoundError || err instanceof SourceNotFoundError) {
			return Response.json({ error: err.message }, { status: 404 });
		}
		const message = err instanceof Error ? err.message : String(err);
		return Response.json({ error: message }, { status: 400 });
	}
}

/**
 * DELETE /api/projects/:id/sources/:sourceId
 * Removes an attached source from the project workspace.
 * Fails fast with HTTP 400 on malformed ID formats and HTTP 404 if project or source is missing.
 */
export async function DELETE(
	_req: Request,
	{ params }: { params: Promise<{ id: string; sourceId: string }> },
) {
	const { id, sourceId } = await params;

	try {
		const result = await removeProjectSource(id, sourceId);
		return Response.json(result, { status: 200 });
	} catch (err) {
		if (err instanceof InvalidProjectIdError || err instanceof InvalidSourceIdError) {
			return Response.json({ error: err.message }, { status: 400 });
		}
		if (err instanceof ProjectNotFoundError || err instanceof SourceNotFoundError) {
			return Response.json({ error: err.message }, { status: 404 });
		}
		const message = err instanceof Error ? err.message : String(err);
		return Response.json({ error: message }, { status: 500 });
	}
}
