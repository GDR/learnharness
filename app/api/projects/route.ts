import { projectSettingsSchema } from "@/src/core";
import { getProjectStore, validateProjectId } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/projects
 * Lists all registered projects with their summaries/settings and identifies the active project.
 */
export async function GET() {
	try {
		const store = getProjectStore();
		const [projects, activeProjectId] = await Promise.all([
			store.listProjects(),
			store.getActiveProjectId(),
		]);
		return Response.json({ projects, activeProjectId });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return Response.json({ error: message }, { status: 500 });
	}
}

/**
 * POST /api/projects
 * Creates a new project workspace. Validates input schemas and fails fast on errors.
 */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => null)) as {
		name?: unknown;
		description?: unknown;
		settings?: unknown;
		id?: unknown;
	} | null;

	if (!body || typeof body !== "object") {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	if (typeof body.name !== "string" || body.name.trim() === "") {
		return Response.json({ error: "Project name cannot be empty" }, { status: 400 });
	}

	if (body.description !== undefined && typeof body.description !== "string") {
		return Response.json({ error: "description must be a string" }, { status: 400 });
	}

	if (body.id !== undefined) {
		if (typeof body.id !== "string" || body.id.trim() === "active") {
			return Response.json(
				{ error: body.id === "active" ? 'projectId "active" is reserved' : "Invalid projectId" },
				{ status: 400 },
			);
		}
		try {
			validateProjectId(body.id);
		} catch (err) {
			return Response.json(
				{ error: err instanceof Error ? err.message : "Invalid projectId" },
				{ status: 400 },
			);
		}
	}

	if (body.settings !== undefined) {
		const parsedSettings = projectSettingsSchema.partial().safeParse(body.settings);
		if (!parsedSettings.success) {
			return Response.json(
				{ error: parsedSettings.error.issues[0]?.message ?? "Invalid project settings" },
				{ status: 400 },
			);
		}
	}

	try {
		const store = getProjectStore();
		const project = await store.createProject({
			name: body.name.trim(),
			...(typeof body.description === "string" ? { description: body.description.trim() } : {}),
			...(body.settings && typeof body.settings === "object"
				? { settings: body.settings as Record<string, unknown> }
				: {}),
			...(typeof body.id === "string" ? { id: body.id.trim() } : {}),
		});
		return Response.json({ project }, { status: 201 });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const status = message.includes("already exists") ? 409 : 400;
		return Response.json({ error: message }, { status });
	}
}
