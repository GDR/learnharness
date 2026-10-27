import {
	validateProjectId,
	validateSourceId,
	InvalidProjectIdError,
	InvalidSourceIdError,
	SourceNotFoundError,
	VaultNotFoundError,
} from "@/src/core";
import {
	ProjectNotFoundError,
	VaultUnavailableError,
	scanSourceDocuments,
} from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/projects/:id/sources/:sourceId/scan
 * Triggers an incremental or forced scan of the specified project source.
 * Computes SHA-256 hashes, reconciles document inventory, and persists updates atomically.
 *
 * Status Codes:
 * - 200: Successful scan with ScanResult
 * - 400: Invalid projectId or sourceId format
 * - 404: Project, source, or vault not found
 * - 409: Vault disconnected/unavailable on this machine
 * - 500: Unexpected internal error
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
		const result = await scanSourceDocuments({
			projectId: validProjectId,
			sourceId: validSourceId,
			forceRescan,
		});
		return Response.json(result, { status: 200 });
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
		const message = err instanceof Error ? err.message : String(err);
		return Response.json({ error: message }, { status: 500 });
	}
}

/**
 * GET /api/projects/:id/sources/:sourceId/scan
 * Idempotently scans or fetches source inventory status.
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

	const url = new URL(req.url);
	const forceRescan = url.searchParams.get("forceRescan") === "true";

	try {
		const result = await scanSourceDocuments({
			projectId: validProjectId,
			sourceId: validSourceId,
			forceRescan,
		});
		return Response.json(result, { status: 200 });
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
		const message = err instanceof Error ? err.message : String(err);
		return Response.json({ error: message }, { status: 500 });
	}
}
