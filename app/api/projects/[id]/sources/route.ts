import {
	validateProjectId,
	InvalidProjectIdError,
	validateVaultId,
	InvalidVaultIdError,
	VaultNotFoundError,
	type ProjectSource,
} from "@/src/core";
import {
	resolveProjectContext,
	ProjectNotFoundError,
	getVaultRegistry,
	attachProjectSource,
} from "@/src/server";


export const dynamic = "force-dynamic";

/**
 * GET /api/projects/:id/sources
 * Lists all attached sources configured for a project workspace.
 * Fails fast with HTTP 400 on malformed projectId and HTTP 404 if project is missing.
 */
export async function GET(
	_req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	let validProjectId: string;
	try {
		validProjectId = validateProjectId(id);
	} catch (err) {
		const message = err instanceof Error ? err.message : "Invalid projectId";
		return Response.json({ error: message }, { status: 400 });
	}

	try {
		const context = await resolveProjectContext(validProjectId);
		const sources = await context.sources.listSources(validProjectId);
		return Response.json({ sources });
	} catch (err) {
		if (err instanceof ProjectNotFoundError) {
			return Response.json({ error: err.message }, { status: 404 });
		}
		const message = err instanceof Error ? err.message : String(err);
		return Response.json({ error: message }, { status: 500 });
	}
}

/**
 * POST /api/projects/:id/sources
 * Attaches a registered Obsidian vault as a source to the project workspace.
 * Requires `vaultId`. Verifies vault existence in VaultRegistry (404 if unknown).
 * Normalizes include and exclude globs (defaults exclude to DEFAULT_SOURCE_EXCLUDE).
 * Returns HTTP 201 Created with `{ source: ProjectSource }`.
 */
export async function POST(
	req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	let validProjectId: string;
	try {
		validProjectId = validateProjectId(id);
	} catch (err) {
		const message = err instanceof Error ? err.message : "Invalid projectId";
		return Response.json({ error: message }, { status: 400 });
	}

	// Verify project exists
	try {
		await resolveProjectContext(validProjectId);
	} catch (err) {
		if (err instanceof ProjectNotFoundError) {
			return Response.json({ error: err.message }, { status: 404 });
		}
		const message = err instanceof Error ? err.message : String(err);
		return Response.json({ error: message }, { status: 500 });
	}

	const body = (await req.json().catch(() => null)) as {
		vaultId?: unknown;
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

	if (body.vaultId === undefined || body.vaultId === null) {
		return Response.json({ error: "vaultId is required" }, { status: 400 });
	}

	let validVaultId: string;
	try {
		validVaultId = validateVaultId(body.vaultId);
	} catch (err) {
		const message = err instanceof Error ? err.message : "Invalid vaultId";
		return Response.json({ error: message }, { status: 400 });
	}

	// Verify target vault exists in VaultRegistry
	const registry = getVaultRegistry();
	const vault = await registry.getVault(validVaultId);
	if (!vault) {
		return Response.json({ error: `Vault not found: ${validVaultId}` }, { status: 404 });
	}

	// Validate optional fields
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

	try {
		const source: ProjectSource = await attachProjectSource(validProjectId, {
			vaultId: validVaultId,
			include: body.include,
			exclude: body.exclude,
			recursive: body.recursive,
			enabled: body.enabled,
			syncMode: body.syncMode,
			deletionPolicy: body.deletionPolicy,
		});

		return Response.json({ source }, { status: 201 });
	} catch (err) {
		if (err instanceof VaultNotFoundError) {
			return Response.json({ error: err.message }, { status: 404 });
		}
		if (err instanceof ProjectNotFoundError) {
			return Response.json({ error: err.message }, { status: 404 });
		}
		if (err instanceof InvalidVaultIdError || err instanceof InvalidProjectIdError) {
			return Response.json({ error: err.message }, { status: 400 });
		}
		const message = err instanceof Error ? err.message : String(err);
		return Response.json({ error: message }, { status: 400 });
	}
}
