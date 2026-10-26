import {
	type VaultBinding,
	validateVaultId,
	vaultBindingSchema,
} from "@/src/core";
import {
	getVaultRegistry,
	deleteVaultSafely,
	VaultInUseError,
} from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/vaults/:id
 * Fetches a single vault by its ID.
 * Accepts optional ?check=true to refresh filesystem availability of bindings.
 * Fails fast with HTTP 400 on invalid ID format and HTTP 404 on nonexistent vault.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	let validId: string;
	try {
		validId = validateVaultId(id);
	} catch (err) {
		const message = err instanceof Error ? err.message : "Invalid vaultId";
		return Response.json({ error: message }, { status: 400 });
	}

	try {
		const registry = getVaultRegistry();
		const url = new URL(req.url);
		const shouldCheck = url.searchParams.get("check") === "true";

		let vault = await registry.getVault(validId);
		if (!vault) {
			return Response.json({ error: `Vault not found: ${validId}` }, { status: 404 });
		}

		if (shouldCheck && registry.checkVaultAvailability) {
			const updated = await registry.checkVaultAvailability(validId);
			if (updated) vault = updated;
		}

		return Response.json({ vault });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return Response.json({ error: message }, { status: 500 });
	}
}

/**
 * PATCH /api/vaults/:id
 * Updates mutable fields of a vault: displayName, bindings, or a single binding.
 * Supports status update shortcut ({ status: "available" | "unavailable", deviceId?: string })
 * and checkAvailability: true to probe the local filesystem.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	let validId: string;
	try {
		validId = validateVaultId(id);
	} catch (err) {
		const message = err instanceof Error ? err.message : "Invalid vaultId";
		return Response.json({ error: message }, { status: 400 });
	}

	const registry = getVaultRegistry();
	const existing = await registry.getVault(validId);
	if (!existing) {
		return Response.json({ error: `Vault not found: ${validId}` }, { status: 404 });
	}

	const body = (await req.json().catch(() => null)) as {
		displayName?: unknown;
		bindings?: unknown;
		binding?: unknown;
		deviceId?: unknown;
		status?: unknown;
		checkAvailability?: unknown;
	} | null;

	if (!body || typeof body !== "object") {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	// 1. If checkAvailability requested, refresh status from filesystem
	if (body.checkAvailability === true && registry.checkVaultAvailability) {
		const checked = await registry.checkVaultAvailability(validId);
		if (checked) {
			existing.bindings = checked.bindings;
		}
	}

	// 2. Validate displayName if provided
	let newDisplayName: string | undefined;
	if (body.displayName !== undefined) {
		if (typeof body.displayName !== "string" || body.displayName.trim() === "") {
			return Response.json({ error: "displayName cannot be empty" }, { status: 400 });
		}
		newDisplayName = body.displayName.trim();
	}

	// 3. Validate bindings array if provided
	let newBindings: VaultBinding[] | undefined;
	if (body.bindings !== undefined) {
		if (!Array.isArray(body.bindings) || body.bindings.length === 0) {
			return Response.json({ error: "bindings must be a non-empty array" }, { status: 400 });
		}
		newBindings = [];
		for (const b of body.bindings) {
			const parsed = vaultBindingSchema.safeParse(b);
			if (!parsed.success) {
				return Response.json(
					{ error: parsed.error.issues[0]?.message ?? "Invalid binding structure" },
					{ status: 400 },
				);
			}
			newBindings.push(parsed.data);
		}
	}

	// 4. Validate single binding update if provided
	if (body.binding !== undefined) {
		const parsed = vaultBindingSchema.safeParse(body.binding);
		if (!parsed.success) {
			return Response.json(
				{ error: parsed.error.issues[0]?.message ?? "Invalid binding structure" },
				{ status: 400 },
			);
		}
		await registry.updateBinding(validId, parsed.data);
	}

	// 5. Validate status shortcut if provided (e.g. { status: "available" } or { status: "unavailable", deviceId: "local" })
	if (body.status !== undefined) {
		if (body.status !== "available" && body.status !== "unavailable") {
			return Response.json({ error: 'status must be "available" or "unavailable"' }, { status: 400 });
		}
		const targetDeviceId =
			typeof body.deviceId === "string" && body.deviceId.trim()
				? body.deviceId.trim()
				: (existing.bindings[0]?.deviceId ?? "local");

		const targetBinding = existing.bindings.find((b) => b.deviceId === targetDeviceId);
		if (targetBinding) {
			await registry.updateBinding(validId, {
				deviceId: targetBinding.deviceId,
				rootPath: targetBinding.rootPath,
				status: body.status,
			});
		}
	}

	try {
		let updatedVault = existing;
		if (newDisplayName !== undefined || newBindings !== undefined) {
			updatedVault = await registry.updateVault(validId, {
				...(newDisplayName !== undefined ? { displayName: newDisplayName } : {}),
				...(newBindings !== undefined ? { bindings: newBindings } : {}),
			});
		} else {
			const fresh = await registry.getVault(validId);
			if (fresh) updatedVault = fresh;
		}
		return Response.json({ vault: updatedVault });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return Response.json({ error: message }, { status: 400 });
	}
}

/**
 * DELETE /api/vaults/:id
 * Removes a vault registration.
 * Inspects all active projects for attached sources referencing this vault.
 * If in use, returns HTTP 409 Conflict with attached project details,
 * unless force=true is passed via query param or JSON body.
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	let validId: string;
	try {
		validId = validateVaultId(id);
	} catch (err) {
		const message = err instanceof Error ? err.message : "Invalid vaultId";
		return Response.json({ error: message }, { status: 400 });
	}

	const url = new URL(req.url);
	let force = url.searchParams.get("force") === "true";
	if (!force) {
		try {
			const body = (await req.json().catch(() => null)) as { force?: unknown } | null;
			if (body?.force === true) force = true;
		} catch {
			// ignore json parse error on DELETE
		}
	}

	try {
		const result = await deleteVaultSafely(validId, { force });
		return Response.json({
			ok: true,
			deletedVaultId: validId,
			detachedCount: result.detachedCount,
		});
	} catch (err) {
		if (err instanceof VaultInUseError) {
			return Response.json(
				{
					error: err.message,
					vaultId: err.vaultId,
					attachedProjects: err.attachedProjects,
				},
				{ status: 409 },
			);
		}
		const message = err instanceof Error ? err.message : String(err);
		const status = message.includes("not found") ? 404 : 500;
		return Response.json({ error: message }, { status });
	}
}
