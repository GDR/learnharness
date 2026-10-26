import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { config } from "../proxy.ts";
import {
	createProjectStore,
	setProjectStore,
} from "../src/server";
import {
	GET as getProjects,
	POST as postProjects,
} from "../app/api/projects/route.ts";
import {
	GET as getProjectById,
	PATCH as patchProjectById,
	DELETE as deleteProjectById,
} from "../app/api/projects/[id]/route.ts";
import { POST as archiveProjectById } from "../app/api/projects/[id]/archive/route.ts";
import {
	GET as getActiveProject,
	POST as postActiveProject,
} from "../app/api/projects/active/route.ts";
import { defaultProjectContextPromise } from "../src/server/stores.ts";

test("Milestone A Slice 4 — Project REST APIs", async (t) => {
	await defaultProjectContextPromise;
	let tmpDir = "";

	function setup() {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-api-projects-test-"));
		const testStore = createProjectStore(tmpDir);
		setProjectStore(testStore);
	}

	function teardown() {
		setProjectStore(null);
		try {
			if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup error
		}
	}

	await t.test("GET /api/projects lists projects and reports activeProjectId", async () => {
		setup();
		try {
			const resInitial = await getProjects();
			assert.equal(resInitial.status, 200);
			const dataInitial = (await resInitial.json()) as { projects: unknown[]; activeProjectId: unknown };
			assert.deepEqual(dataInitial.projects, []);
			assert.equal(dataInitial.activeProjectId, null);

			// Create two projects
			await postProjects(
				new Request("http://localhost/api/projects", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name: "Alpha Project", description: "Alpha desc" }),
				}),
			);

			await postProjects(
				new Request("http://localhost/api/projects", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name: "Beta Project" }),
				}),
			);

			const res = await getProjects();
			assert.equal(res.status, 200);
			const data = (await res.json()) as {
				projects: Array<{ name: string; id: string }>;
				activeProjectId: string;
			};
			assert.equal(data.projects.length, 2);
			assert.equal(data.projects[0]!.name, "Alpha Project");
			assert.equal(data.projects[1]!.name, "Beta Project");
			assert.equal(data.activeProjectId, data.projects[0]!.id);
		} finally {
			teardown();
		}
	});

	await t.test("POST /api/projects creates project with auto-generated ID and defaults", async () => {
		setup();
		try {
			const res = await postProjects(
				new Request("http://localhost/api/projects", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						name: "Quantum Mechanics",
						description: "Physics notes",
						settings: { sourceGrounding: "assisted" },
					}),
				}),
			);

			assert.equal(res.status, 201);
			const data = (await res.json()) as {
				project: {
					id: string;
					name: string;
					description: string;
					status: string;
					settings: { defaultStudyScope: string; sourceGrounding: string };
				};
			};
			assert(data.project.id.startsWith("proj_"));
			assert.equal(data.project.name, "Quantum Mechanics");
			assert.equal(data.project.description, "Physics notes");
			assert.equal(data.project.status, "active");
			assert.equal(data.project.settings.sourceGrounding, "assisted");
			assert.equal(data.project.settings.defaultStudyScope, "all");
		} finally {
			teardown();
		}
	});

	await t.test("POST /api/projects creates project with custom ID", async () => {
		setup();
		try {
			const res = await postProjects(
				new Request("http://localhost/api/projects", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						id: "proj_custom_101",
						name: "Custom ID Project",
					}),
				}),
			);

			assert.equal(res.status, 201);
			const data = (await res.json()) as { project: { id: string; name: string } };
			assert.equal(data.project.id, "proj_custom_101");
			assert.equal(data.project.name, "Custom ID Project");
		} finally {
			teardown();
		}
	});

	await t.test("POST /api/projects validation failures return HTTP 400 or 409", async () => {
		setup();
		try {
			// Missing / empty name
			const emptyNameRes = await postProjects(
				new Request("http://localhost/api/projects", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name: "   " }),
				}),
			);
			assert.equal(emptyNameRes.status, 400);

			// Non-string description
			const badDescRes = await postProjects(
				new Request("http://localhost/api/projects", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name: "Valid", description: 12345 }),
				}),
			);
			assert.equal(badDescRes.status, 400);

			// Invalid custom ID format
			const badIdRes = await postProjects(
				new Request("http://localhost/api/projects", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name: "Valid", id: "proj/invalid/slash" }),
				}),
			);
			assert.equal(badIdRes.status, 400);

			// Reserved ID "active"
			const reservedRes = await postProjects(
				new Request("http://localhost/api/projects", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name: "Valid", id: "active" }),
				}),
			);
			assert.equal(reservedRes.status, 400);

			// Invalid settings enum value
			const badSettingsRes = await postProjects(
				new Request("http://localhost/api/projects", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						name: "Valid",
						settings: { defaultStudyScope: "invalid_enum" },
					}),
				}),
			);
			assert.equal(badSettingsRes.status, 400);

			// Duplicate ID -> 409 Conflict
			await postProjects(
				new Request("http://localhost/api/projects", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ id: "proj_dupe", name: "Dupe 1" }),
				}),
			);
			const dupeRes = await postProjects(
				new Request("http://localhost/api/projects", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ id: "proj_dupe", name: "Dupe 2" }),
				}),
			);
			assert.equal(dupeRes.status, 409);

			// Malformed JSON body -> 400
			const badJsonRes = await postProjects(
				new Request("http://localhost/api/projects", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: "not-json",
				}),
			);
			assert.equal(badJsonRes.status, 400);
		} finally {
			teardown();
		}
	});

	await t.test("GET /api/projects/:id returns single project and handles 400 / 404", async () => {
		setup();
		try {
			const createRes = await postProjects(
				new Request("http://localhost/api/projects", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ id: "proj_get_test", name: "Get Test" }),
				}),
			);
			assert.equal(createRes.status, 201);

			// Valid lookup
			const okRes = await getProjectById(new Request("http://localhost/api/projects/proj_get_test"), {
				params: Promise.resolve({ id: "proj_get_test" }),
			});
			assert.equal(okRes.status, 200);
			const okData = (await okRes.json()) as { project: { id: string; name: string } };
			assert.equal(okData.project.id, "proj_get_test");
			assert.equal(okData.project.name, "Get Test");

			// Non-existent ID -> 404
			const notFoundRes = await getProjectById(
				new Request("http://localhost/api/projects/proj_unknown"),
				{ params: Promise.resolve({ id: "proj_unknown" }) },
			);
			assert.equal(notFoundRes.status, 404);

			// Invalid ID format -> 400
			const invalidRes = await getProjectById(
				new Request("http://localhost/api/projects/../bad"),
				{ params: Promise.resolve({ id: "../bad" }) },
			);
			assert.equal(invalidRes.status, 400);
		} finally {
			teardown();
		}
	});

	await t.test("PATCH /api/projects/:id updates fields and activates project", async () => {
		setup();
		try {
			await postProjects(
				new Request("http://localhost/api/projects", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ id: "proj_patch_1", name: "Original 1" }),
				}),
			);
			await postProjects(
				new Request("http://localhost/api/projects", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ id: "proj_patch_2", name: "Original 2" }),
				}),
			);

			// Update fields of proj_patch_1
			const patchRes = await patchProjectById(
				new Request("http://localhost/api/projects/proj_patch_1", {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						name: "Renamed 1",
						description: "New description",
						settings: { defaultStudyScope: "manual" },
					}),
				}),
				{ params: Promise.resolve({ id: "proj_patch_1" }) },
			);
			assert.equal(patchRes.status, 200);
			const patchData = (await patchRes.json()) as {
				project: { name: string; description: string; settings: { defaultStudyScope: string } };
			};
			assert.equal(patchData.project.name, "Renamed 1");
			assert.equal(patchData.project.description, "New description");
			assert.equal(patchData.project.settings.defaultStudyScope, "manual");

			// Activate proj_patch_2 via { active: true }
			const activateRes = await patchProjectById(
				new Request("http://localhost/api/projects/proj_patch_2", {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ active: true }),
				}),
				{ params: Promise.resolve({ id: "proj_patch_2" }) },
			);
			assert.equal(activateRes.status, 200);
			const activateData = (await activateRes.json()) as { active: boolean };
			assert.equal(activateData.active, true);

			// Verify active project via GET /api/projects/active
			const activeRes = await getActiveProject();
			assert.equal(activeRes.status, 200);
			const activeData = (await activeRes.json()) as { activeProjectId: string };
			assert.equal(activeData.activeProjectId, "proj_patch_2");

			// Validation errors on PATCH
			const badNameRes = await patchProjectById(
				new Request("http://localhost/api/projects/proj_patch_1", {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name: "" }),
				}),
				{ params: Promise.resolve({ id: "proj_patch_1" }) },
			);
			assert.equal(badNameRes.status, 400);

			const badStatusRes = await patchProjectById(
				new Request("http://localhost/api/projects/proj_patch_1", {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ status: "bogus_status" }),
				}),
				{ params: Promise.resolve({ id: "proj_patch_1" }) },
			);
			assert.equal(badStatusRes.status, 400);

			// Not found -> 404
			const notFoundRes = await patchProjectById(
				new Request("http://localhost/api/projects/proj_not_exist", {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name: "Valid" }),
				}),
				{ params: Promise.resolve({ id: "proj_not_exist" }) },
			);
			assert.equal(notFoundRes.status, 404);

			// Invalid ID format -> 400
			const badIdRes = await patchProjectById(
				new Request("http://localhost/api/projects/bad*id", {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name: "Valid" }),
				}),
				{ params: Promise.resolve({ id: "bad*id" }) },
			);
			assert.equal(badIdRes.status, 400);
		} finally {
			teardown();
		}
	});

	await t.test("POST /api/projects/:id/archive archives project", async () => {
		setup();
		try {
			await postProjects(
				new Request("http://localhost/api/projects", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ id: "proj_archive_test", name: "To Archive" }),
				}),
			);

			const archiveRes = await archiveProjectById(
				new Request("http://localhost/api/projects/proj_archive_test/archive", { method: "POST" }),
				{ params: Promise.resolve({ id: "proj_archive_test" }) },
			);
			assert.equal(archiveRes.status, 200);
			const archiveData = (await archiveRes.json()) as { project: { status: string } };
			assert.equal(archiveData.project.status, "archived");

			// Non-existent project -> 404
			const notFoundRes = await archiveProjectById(
				new Request("http://localhost/api/projects/proj_none/archive", { method: "POST" }),
				{ params: Promise.resolve({ id: "proj_none" }) },
			);
			assert.equal(notFoundRes.status, 404);

			// Invalid ID format -> 400
			const badIdRes = await archiveProjectById(
				new Request("http://localhost/api/projects/bad_id!/archive", { method: "POST" }),
				{ params: Promise.resolve({ id: "bad_id!" }) },
			);
			assert.equal(badIdRes.status, 400);
		} finally {
			teardown();
		}
	});

	await t.test("DELETE /api/projects/:id removes project workspace", async () => {
		setup();
		try {
			await postProjects(
				new Request("http://localhost/api/projects", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ id: "proj_to_delete", name: "Deletable" }),
				}),
			);

			const delRes = await deleteProjectById(
				new Request("http://localhost/api/projects/proj_to_delete", { method: "DELETE" }),
				{ params: Promise.resolve({ id: "proj_to_delete" }) },
			);
			assert.equal(delRes.status, 200);
			const delData = (await delRes.json()) as { ok: boolean };
			assert.equal(delData.ok, true);

			// Subsequent GET returns 404
			const getRes = await getProjectById(
				new Request("http://localhost/api/projects/proj_to_delete"),
				{ params: Promise.resolve({ id: "proj_to_delete" }) },
			);
			assert.equal(getRes.status, 404);

			// Deleting again returns 404
			const delAgainRes = await deleteProjectById(
				new Request("http://localhost/api/projects/proj_to_delete", { method: "DELETE" }),
				{ params: Promise.resolve({ id: "proj_to_delete" }) },
			);
			assert.equal(delAgainRes.status, 404);

			// Invalid ID format -> 400
			const badIdRes = await deleteProjectById(
				new Request("http://localhost/api/projects/invalid%20id", { method: "DELETE" }),
				{ params: Promise.resolve({ id: "invalid id" }) },
			);
			assert.equal(badIdRes.status, 400);
		} finally {
			teardown();
		}
	});

	await t.test(
		"GET /api/projects/active and POST /api/projects/active query and switch active project",
		async () => {
			setup();
			try {
				await postProjects(
					new Request("http://localhost/api/projects", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ id: "proj_one", name: "Project One" }),
					}),
				);
				await postProjects(
					new Request("http://localhost/api/projects", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ id: "proj_two", name: "Project Two" }),
					}),
				);

				// Initially active is proj_one
				const initialRes = await getActiveProject();
				assert.equal(initialRes.status, 200);
				const initialData = (await initialRes.json()) as {
					activeProjectId: string;
					activeProject: { id: string; name: string };
				};
				assert.equal(initialData.activeProjectId, "proj_one");
				assert.equal(initialData.activeProject.name, "Project One");

				// Switch to proj_two
				const switchRes = await postActiveProject(
					new Request("http://localhost/api/projects/active", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ projectId: "proj_two" }),
					}),
				);
				assert.equal(switchRes.status, 200);
				const switchData = (await switchRes.json()) as { ok: boolean; activeProjectId: string };
				assert.equal(switchData.ok, true);
				assert.equal(switchData.activeProjectId, "proj_two");

				// Check GET reflects switch
				const switchedRes = await getActiveProject();
				const switchedData = (await switchedRes.json()) as {
					activeProjectId: string;
					activeProject: { id: string };
				};
				assert.equal(switchedData.activeProjectId, "proj_two");
				assert.equal(switchedData.activeProject.id, "proj_two");

				// Switch to non-existent project -> 404
				const notFoundRes = await postActiveProject(
					new Request("http://localhost/api/projects/active", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ projectId: "proj_missing" }),
					}),
				);
				assert.equal(notFoundRes.status, 404);

				// Switch with invalid ID format -> 400
				const badIdRes = await postActiveProject(
					new Request("http://localhost/api/projects/active", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ projectId: "bad/id" }),
					}),
				);
				assert.equal(badIdRes.status, 400);

				// Switch with missing body -> 400
				const noBodyRes = await postActiveProject(
					new Request("http://localhost/api/projects/active", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({}),
					}),
				);
				assert.equal(noBodyRes.status, 400);
			} finally {
				teardown();
			}
		},
	);

	await t.test("Desktop proxy matcher covers all project API routes", () => {
		const pattern = new RegExp("^" + config.matcher.replace(":path*", ".*") + "$");
		for (const pathname of [
			"/api/projects",
			"/api/projects/proj_abc",
			"/api/projects/proj_abc/archive",
			"/api/projects/active",
		]) {
			assert(pattern.test(pathname), `Proxy matcher should match ${pathname}`);
		}
	});
});
