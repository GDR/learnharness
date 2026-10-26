import {
	type VaultBinding,
	validateVaultId,
	vaultBindingSchema,
} from "@/src/core";
import { getVaultRegistry } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/vaults
 * Lists all registered Obsidian vaults with device bindings.
 * Accepts optional ?check=true query parameter to inspect and refresh
 * local filesystem availability ("available" vs "unavailable").
 */
export async function GET(req: Request) {
	try {
		const registry = getVaultRegistry();
		const url = new URL(req.url);
		const shouldCheck = url.searchParams.get("check") === "true";

		let vaults;
		if (shouldCheck && registry.checkAllVaultsAvailability) {
			vaults = await registry.checkAllVaultsAvailability();
		} else {
			vaults = await registry.listVaults();
		}
		return Response.json({ vaults });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return Response.json({ error: message }, { status: 500 });
	}
}

/**
 * POST /api/vaults
 * Registers a new Obsidian vault.
 * Supports explicit `bindings` array or shorthand `path` / `rootPath`.
 * Fails fast with HTTP 400 on invalid input and HTTP 409 on duplicate vault ID.
 */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => null)) as {
		displayName?: unknown;
		id?: unknown;
		path?: unknown;
		rootPath?: unknown;
		deviceId?: unknown;
		status?: unknown;
		bindings?: unknown;
	} | null;

	if (!body || typeof body !== "object") {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	if (typeof body.displayName !== "string" || body.displayName.trim() === "") {
		return Response.json({ error: "displayName cannot be empty" }, { status: 400 });
	}

	let customId: string | undefined;
	if (body.id !== undefined) {
		try {
			customId = validateVaultId(body.id);
		} catch (err) {
			const message = err instanceof Error ? err.message : "Invalid vaultId";
			return Response.json({ error: message }, { status: 400 });
		}
	}

	const bindings: VaultBinding[] = [];

	if (Array.isArray(body.bindings)) {
		if (body.bindings.length === 0) {
			return Response.json({ error: "Vault must have at least one binding" }, { status: 400 });
		}
		for (const b of body.bindings) {
			if (!b || typeof b !== "object") {
				return Response.json({ error: "Each binding must be an object" }, { status: 400 });
			}
			const bindingObj = b as { deviceId?: unknown; rootPath?: unknown; status?: unknown };
			if (typeof bindingObj.rootPath !== "string" || bindingObj.rootPath.trim() === "") {
				return Response.json({ error: "Binding rootPath cannot be empty" }, { status: 400 });
			}
			const deviceId =
				typeof bindingObj.deviceId === "string" && bindingObj.deviceId.trim()
					? bindingObj.deviceId.trim()
					: "local";
			const status =
				bindingObj.status === "available" || bindingObj.status === "unavailable"
					? bindingObj.status
					: "available";

			const parsed = vaultBindingSchema.safeParse({
				deviceId,
				rootPath: bindingObj.rootPath.trim(),
				status,
			});
			if (!parsed.success) {
				return Response.json(
					{ error: parsed.error.issues[0]?.message ?? "Invalid binding structure" },
					{ status: 400 },
				);
			}
			bindings.push(parsed.data);
		}
	} else if (typeof body.path === "string" || typeof body.rootPath === "string") {
		const rawPath = typeof body.path === "string" ? body.path : (body.rootPath as string);
		if (!rawPath.trim()) {
			return Response.json({ error: "Vault path cannot be empty" }, { status: 400 });
		}
		const deviceId =
			typeof body.deviceId === "string" && body.deviceId.trim()
				? body.deviceId.trim()
				: "local";
		const status =
			body.status === "available" || body.status === "unavailable"
				? body.status
				: "available";

		const parsed = vaultBindingSchema.safeParse({
			deviceId,
			rootPath: rawPath.trim(),
			status,
		});
		if (!parsed.success) {
			return Response.json(
				{ error: parsed.error.issues[0]?.message ?? "Invalid binding structure" },
				{ status: 400 },
			);
		}
		bindings.push(parsed.data);
	} else {
		return Response.json(
			{ error: "Vault requires bindings array or path/rootPath" },
			{ status: 400 },
		);
	}

	try {
		const registry = getVaultRegistry();
		const vault = await registry.registerVault({
			displayName: body.displayName.trim(),
			kind: "obsidian",
			bindings,
			...(customId ? { id: customId } : {}),
		});
		return Response.json({ vault }, { status: 201 });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const status = message.includes("already exists") ? 409 : 400;
		return Response.json({ error: message }, { status });
	}
}
