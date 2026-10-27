import { validateProjectId, InvalidProjectIdError } from "@/src/core";
import { getIndexingQueue, resolveProjectContext, ProjectNotFoundError } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/projects/:id/index/status
 * Returns project-level indexing status: active jobs, queued jobs, global concurrency limits, and recent jobs.
 */
export async function GET(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id: rawProjectId } = await params;

	let validProjectId: string;
	try {
		validProjectId = validateProjectId(rawProjectId);
	} catch (err) {
		const message = err instanceof Error ? err.message : "Invalid identifier format";
		return Response.json({ error: message, code: "INVALID_ID" }, { status: 400 });
	}

	try {
		await resolveProjectContext(validProjectId);
		const queue = getIndexingQueue();
		const allProjectJobs = await queue.listIndexingJobs(validProjectId);

		const activeJobs = allProjectJobs.filter(
			(j) => j.state === "scanning" || j.state === "extracting" || j.state === "validating" || j.state === "committing",
		);
		const queuedJobs = allProjectJobs.filter((j) => j.state === "queued");
		const recentJobs = allProjectJobs.filter(
			(j) => j.state === "completed" || j.state === "failed" || j.state === "canceled",
		);

		return Response.json({
			activeJobs,
			queuedJobs,
			concurrency: {
				activeCount: queue.getActiveJobsCount(),
				queuedCount: queue.getQueuedJobsCount(),
				maxConcurrency: queue.getMaxConcurrency(),
			},
			recentJobs,
		}, { status: 200 });
	} catch (err) {
		if (err instanceof InvalidProjectIdError) {
			return Response.json({ error: err.message, code: "INVALID_ID" }, { status: 400 });
		}
		if (err instanceof ProjectNotFoundError) {
			return Response.json({ error: err.message, code: "NOT_FOUND" }, { status: 404 });
		}
		const message = err instanceof Error ? err.message : String(err);
		return Response.json({ error: message }, { status: 500 });
	}
}
