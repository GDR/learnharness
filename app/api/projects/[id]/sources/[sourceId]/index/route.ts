import {
	validateProjectId,
	validateSourceId,
	InvalidProjectIdError,
	InvalidSourceIdError,
	SourceNotFoundError,
	VaultNotFoundError,
	IndexingConflictError,
} from "@/src/core";
import {
	ProjectNotFoundError,
	VaultUnavailableError,
	resolveProjectSource,
	getIndexingQueue,
} from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/projects/:id/sources/:sourceId/index
 * Triggers an asynchronous indexing job for the given source.
 * Enforces global concurrency (max 3) and per-source mutex serialization (409).
 */
export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string; sourceId: string }> },
) {
	const { id: rawProjectId, sourceId: rawSourceId } = await params;

	let validProjectId: string;
	let validSourceId: string;
	try {
		validProjectId = validateProjectId(rawProjectId);
		validSourceId = validateSourceId(rawSourceId);
	} catch (err) {
		const message = err instanceof Error ? err.message : "Invalid identifier format";
		return Response.json({ error: message, code: "INVALID_ID" }, { status: 400 });
	}

	const body = (await req.json().catch(() => ({}))) as { forceRescan?: unknown } | null;
	const forceRescan = body?.forceRescan === true;

	try {
		const queue = getIndexingQueue();
		const job = await queue.triggerIndexing({
			projectId: validProjectId,
			sourceId: validSourceId,
			forceRescan,
		});

		return Response.json({ job }, { status: 202 });
	} catch (err) {
		if (err instanceof InvalidProjectIdError || err instanceof InvalidSourceIdError) {
			return Response.json({ error: err.message, code: "INVALID_ID" }, { status: 400 });
		}
		if (
			err instanceof ProjectNotFoundError ||
			err instanceof SourceNotFoundError ||
			err instanceof VaultNotFoundError
		) {
			return Response.json({ error: err.message, code: "NOT_FOUND" }, { status: 404 });
		}
		if (err instanceof VaultUnavailableError) {
			return Response.json(
				{ error: "Vault is unavailable", code: "VAULT_UNAVAILABLE" },
				{ status: 409 },
			);
		}
		if (err instanceof IndexingConflictError) {
			return Response.json(
				{
					error: err.message,
					code: "INDEXING_CONFLICT",
					activeJobId: err.activeJobId,
				},
				{ status: 409 },
			);
		}
		const message = err instanceof Error ? err.message : String(err);
		return Response.json({ error: message }, { status: 500 });
	}
}

/**
 * GET /api/projects/:id/sources/:sourceId/index
 * Returns active job and recent indexing history for this source.
 */
export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string; sourceId: string }> },
) {
	const { id: rawProjectId, sourceId: rawSourceId } = await params;

	let validProjectId: string;
	let validSourceId: string;
	try {
		validProjectId = validateProjectId(rawProjectId);
		validSourceId = validateSourceId(rawSourceId);
	} catch (err) {
		const message = err instanceof Error ? err.message : "Invalid identifier format";
		return Response.json({ error: message, code: "INVALID_ID" }, { status: 400 });
	}

	try {
		await resolveProjectSource(validProjectId, validSourceId);
		const queue = getIndexingQueue();
		const activeJob = queue.getActiveJobForSource(validProjectId, validSourceId);
		const recentJobs = await queue.listIndexingJobs(validProjectId, validSourceId);
		const latestJob = recentJobs.find((j) => j.id !== activeJob?.id) ?? null;

		return Response.json({ activeJob, latestJob, recentJobs }, { status: 200 });
	} catch (err) {
		if (err instanceof InvalidProjectIdError || err instanceof InvalidSourceIdError) {
			return Response.json({ error: err.message, code: "INVALID_ID" }, { status: 400 });
		}
		if (err instanceof ProjectNotFoundError || err instanceof SourceNotFoundError) {
			return Response.json({ error: err.message, code: "NOT_FOUND" }, { status: 404 });
		}
		const message = err instanceof Error ? err.message : String(err);
		return Response.json({ error: message }, { status: 500 });
	}
}

/**
 * DELETE /api/projects/:id/sources/:sourceId/index
 * Cancels any running or queued indexing job for this source.
 */
export async function DELETE(
	req: Request,
	{ params }: { params: Promise<{ id: string; sourceId: string }> },
) {
	const { id: rawProjectId, sourceId: rawSourceId } = await params;

	let validProjectId: string;
	let validSourceId: string;
	try {
		validProjectId = validateProjectId(rawProjectId);
		validSourceId = validateSourceId(rawSourceId);
	} catch (err) {
		const message = err instanceof Error ? err.message : "Invalid identifier format";
		return Response.json({ error: message, code: "INVALID_ID" }, { status: 400 });
	}

	try {
		await resolveProjectSource(validProjectId, validSourceId);
		const queue = getIndexingQueue();
		const activeJob = queue.getActiveJobForSource(validProjectId, validSourceId);
		if (!activeJob) {
			return Response.json({ error: "No active job found for source", code: "NOT_FOUND" }, { status: 404 });
		}

		const canceled = await queue.cancelIndexingJob(validProjectId, activeJob.id);
		return Response.json({ job: canceled }, { status: 200 });
	} catch (err) {
		if (err instanceof InvalidProjectIdError || err instanceof InvalidSourceIdError) {
			return Response.json({ error: err.message, code: "INVALID_ID" }, { status: 400 });
		}
		if (err instanceof ProjectNotFoundError || err instanceof SourceNotFoundError) {
			return Response.json({ error: err.message, code: "NOT_FOUND" }, { status: 404 });
		}
		const message = err instanceof Error ? err.message : String(err);
		return Response.json({ error: message }, { status: 500 });
	}
}
