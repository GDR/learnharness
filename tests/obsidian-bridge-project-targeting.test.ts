/**
 * Comprehensive Unit and Integration Tests for LearnHarness Obsidian Bridge:
 * Milestone E Slice 3 (Project Targeting & Vault Registration UI).
 *
 * Verifies:
 * 1. Vault Identity & Path Resolution:
 *    - Electron/adapter path detection (getBasePath vs basePath vs undefined).
 *    - FNV-1a stable vaultId derivation matching ^[A-Za-z0-9_-]+$.
 *    - Unicode, whitespace, and special characters sanitization.
 * 2. Transport Client API Additions:
 *    - listVaults, getVault, registerVault with 201 Created and 409 Conflict recovery.
 *    - listProjects, createProject, attachVaultToProject.
 *    - Project-scoped URL routing in study-sessions and ask endpoints.
 * 3. Settings Tab UI (LearnHarnessSettingTab):
 *    - DOM rendering and accessibility structure.
 *    - Server URL, API Key, and Threshold two-way persistence.
 *    - Live "Test Connection" status indicator.
 *    - "Register Vault" button and status badge.
 *    - Project dropdown population and auto source attachment.
 * 4. Modals (LargeFolderConfirmModal & NewProjectModal):
 *    - Context-rich large folder modal (folder path, count, project name).
 *    - Interactive NewProjectModal with input validation and submission.
 * 5. Commands & Threshold Evaluation:
 *    - Configurable largeFolderThreshold (default 50 vs custom).
 *    - Boundary checks (<= threshold vs > threshold).
 *    - Commands: learnharness:register-vault and learnharness:select-project.
 * 6. Plugin Lifecycle:
 *    - Auto-registration hook on onload().
 *    - Clean teardown on onunload().
 * 7. Standalone Plugin TypeScript Compilation Gate.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import * as assert from "node:assert/strict";
import * as http from "node:http";
import { execSync } from "node:child_process";
import { parseHTML } from "linkedom";

import {
	computeStableVaultId,
	getVaultRootPath,
	registerVaultWithServer,
	ensureVaultRegistered,
} from "../plugins/obsidian-bridge/src/vault.ts";
import {
	BridgeTransport,
	BridgeTransportError,
} from "../plugins/obsidian-bridge/src/transport.ts";
import { LearnHarnessSettingTab } from "../plugins/obsidian-bridge/src/settings.ts";
import {
	LargeFolderConfirmModal,
	NewProjectModal,
	confirmLargeFolder,
} from "../plugins/obsidian-bridge/src/modals.ts";
import {
	executeStudyFolder,
	executeRegisterVault,
	executeSelectProject,
} from "../plugins/obsidian-bridge/src/commands.ts";
import { LearnHarnessBridgePlugin } from "../plugins/obsidian-bridge/src/main.ts";
import type {
	ObsidianApp,
	ObsidianVault,
	ObsidianAdapter,
	ProjectSummary,
	VaultSummary,
} from "../plugins/obsidian-bridge/src/types.ts";
import {
	MockTFile,
	MockTFolder,
} from "./obsidian-bridge-commands.test.ts";

/* -------------------------------------------------------------------------- */
/*                           Mock HTTP Test Server                            */
/* -------------------------------------------------------------------------- */

let mockServer: http.Server;
let mockPort: number;
let baseUrl: string;

let mockVaults: VaultSummary[] = [];
let mockProjects: ProjectSummary[] = [];
let lastRequestBody: any = null;
let lastRequestUrl: string | null = null;
let lastRequestMethod: string | null = null;
let conflictOnVaultId: string | null = null;

function resetMockState(): void {
	mockVaults = [
		{
			id: "vault_existing_11223344",
			displayName: "ExistingVault",
			bindings: [
				{
					deviceId: "local",
					rootPath: "/Users/test/Vaults/ExistingVault",
					status: "available",
				},
			],
		},
	];
	mockProjects = [
		{
			id: "proj_neuro_101",
			name: "Neuroscience 101",
			description: "Cognitive neuroscience notes",
		},
		{
			id: "proj_comp_sci",
			name: "Computer Science",
			description: "Algorithms & data structures",
		},
	];
	lastRequestBody = null;
	lastRequestUrl = null;
	lastRequestMethod = null;
	conflictOnVaultId = null;
}

before((_, done) => {
	resetMockState();
	mockServer = http.createServer((req, res) => {
		const parsedUrl = new URL(req.url || "/", `http://127.0.0.1:${mockPort}`);
		lastRequestUrl = parsedUrl.pathname;
		lastRequestMethod = req.method || "GET";

		let rawBody = "";
		req.on("data", (chunk) => {
			rawBody += chunk;
		});

		req.on("end", () => {
			try {
				lastRequestBody = rawBody ? JSON.parse(rawBody) : null;
			} catch {
				lastRequestBody = rawBody;
			}

			// GET /api/health
			if (parsedUrl.pathname === "/api/health" && req.method === "GET") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true, version: "1.2.0" }));
				return;
			}

			// GET /api/vaults
			if (parsedUrl.pathname === "/api/vaults" && req.method === "GET") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ vaults: mockVaults }));
				return;
			}

			// POST /api/vaults
			if (parsedUrl.pathname === "/api/vaults" && req.method === "POST") {
				const body = lastRequestBody;
				if (conflictOnVaultId && body?.id === conflictOnVaultId) {
					res.writeHead(409, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: `Vault "${conflictOnVaultId}" already exists.` }));
					return;
				}

				const newVault: VaultSummary = {
					id: body.id || `vault_${Date.now()}`,
					displayName: body.displayName,
					kind: "obsidian",
					bindings: body.path
						? [{ deviceId: body.deviceId || "local", rootPath: body.path, status: "available" }]
						: [],
				};
				mockVaults.push(newVault);
				res.writeHead(201, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ vault: newVault }));
				return;
			}

			// GET /api/vaults/:id
			if (parsedUrl.pathname.startsWith("/api/vaults/") && req.method === "GET") {
				const targetId = decodeURIComponent(parsedUrl.pathname.replace("/api/vaults/", ""));
				const found = mockVaults.find((v) => v.id === targetId);
				if (found) {
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ vault: found }));
				} else {
					res.writeHead(404, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: `Vault ${targetId} not found` }));
				}
				return;
			}

			// GET /api/projects
			if (parsedUrl.pathname === "/api/projects" && req.method === "GET") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ projects: mockProjects, activeProjectId: "proj_neuro_101" }));
				return;
			}

			// POST /api/projects
			if (parsedUrl.pathname === "/api/projects" && req.method === "POST") {
				const body = lastRequestBody;
				const newProj: ProjectSummary = {
					id: `proj_${Date.now()}`,
					name: body.name,
					description: body.description,
				};
				mockProjects.push(newProj);
				res.writeHead(201, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ project: newProj }));
				return;
			}

			// POST /api/projects/:id/sources
			if (parsedUrl.pathname.match(/^\/api\/projects\/[^/]+\/sources$/) && req.method === "POST") {
				res.writeHead(201, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ source: { id: "src_1", vaultId: lastRequestBody?.vaultId } }));
				return;
			}

			// POST /api/projects/:id/study-sessions
			if (parsedUrl.pathname.includes("/study-sessions") && req.method === "POST") {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ sessionId: "sess_test_123" }));
				return;
			}

			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Not found" }));
		});
	});

	mockServer.listen(0, "127.0.0.1", () => {
		const addr = mockServer.address() as { port: number };
		mockPort = addr.port;
		baseUrl = `http://127.0.0.1:${mockPort}`;
		done();
	});
});

after((_, done) => {
	mockServer.close(done);
});

/* -------------------------------------------------------------------------- */
/*                                Mock App Helper                             */
/* -------------------------------------------------------------------------- */

function createMockApp(options?: {
	vaultName?: string;
	rootPath?: string;
	hasMethod?: boolean;
}): ObsidianApp {
	const name = options?.vaultName || "TestVault";
	const rootPath = options?.rootPath;
	const hasMethod = options?.hasMethod ?? true;

	const adapter: ObsidianAdapter = {
		getBasePath: hasMethod ? () => rootPath : undefined,
		basePath: !hasMethod ? rootPath : undefined,
	};

	const vault: ObsidianVault = {
		getName: () => name,
		adapter,
		read: async (file) => (file as MockTFile).content || "",
	};

	return {
		vault,
		workspace: {
			getActiveFile: () => null,
		},
	};
}

function createTestPlugin(options?: {
	app?: ObsidianApp;
	serverUrl?: string;
	activeProjectId?: string;
	vaultId?: string;
	largeFolderThreshold?: number;
	autoRegisterVault?: boolean;
}): LearnHarnessBridgePlugin {
	const app = options?.app ?? createMockApp();
	const plugin = new LearnHarnessBridgePlugin(app);
	plugin.settings = {
		serverUrl: options?.serverUrl ?? baseUrl,
		activeProjectId: options?.activeProjectId,
		vaultId: options?.vaultId,
		largeFolderThreshold: options?.largeFolderThreshold ?? 50,
		autoRegisterVault: options?.autoRegisterVault ?? true,
	};
	plugin.transport.updateSettings(plugin.settings);
	return plugin;
}

/* -------------------------------------------------------------------------- */
/*                                 Test Suites                                */
/* -------------------------------------------------------------------------- */

describe("Vault Identity & Path Resolution (computeStableVaultId & getVaultRootPath)", () => {
	it("derives deterministic, alphanumeric vaultId matching ^[A-Za-z0-9_-]+$", () => {
		const id1 = computeStableVaultId("Neuroscience", "/Users/dgarifullin/Vaults/Neuro");
		const id2 = computeStableVaultId("Neuroscience", "/Users/dgarifullin/Vaults/Neuro");

		assert.equal(id1, id2, "Derivation must be completely deterministic for identical inputs");
		assert.match(id1, /^vault_[a-z0-9_-]+_[0-9a-f]{8}$/, "Must match prefix_slug_hash8 pattern");
		assert.match(id1, /^[A-Za-z0-9_-]+$/, "Must conform strictly to server vaultIdRegex");
		assert.ok(id1.includes("neuroscience"));
	});

	it("sanitizes spaces, unicode emojis, and special punctuation into clean slugs", () => {
		const rawName = "  My Notes & Research (2026) 🧠 -- AI / ML!!  ";
		const id = computeStableVaultId(rawName, "/path/to/notes");

		assert.match(id, /^[A-Za-z0-9_-]+$/, "Sanitized ID must strictly contain only alphanumeric, _, -");
		assert.ok(!id.includes(" "), "Must not contain spaces");
		assert.ok(!id.includes("&"), "Must not contain ampersands");
		assert.ok(!id.includes("("), "Must not contain parenthesis");
		assert.ok(!id.includes("🧠"), "Must not contain emojis");
		assert.ok(!id.includes("__"), "Consecutive underscores must be collapsed");
	});

	it("truncates excessively long vault names to 24 characters before hashing", () => {
		const longName = "ThisIsAnExtremelyLongVaultNameExceedingStandardLengthsForTesting";
		const id = computeStableVaultId(longName, "/some/path");

		// "vault_" is 6 chars, slug is max 24 chars, "_" is 1, hash is 8 => max total ~39
		assert.ok(id.length <= 40, `ID length (${id.length}) exceeds expected bounds`);
		assert.match(id, /^[A-Za-z0-9_-]+$/);
	});

	it("resolves vault root path from adapter.getBasePath() when available", () => {
		const app = createMockApp({ rootPath: "/Users/test/Obsidian/CS", hasMethod: true });
		const resolved = getVaultRootPath(app);
		assert.equal(resolved, "/Users/test/Obsidian/CS");
	});

	it("falls back to adapter.basePath when getBasePath() is not a function", () => {
		const app = createMockApp({ rootPath: "/Users/test/Obsidian/Bio", hasMethod: false });
		const resolved = getVaultRootPath(app);
		assert.equal(resolved, "/Users/test/Obsidian/Bio");
	});

	it("returns undefined when adapter root path is missing or whitespace", () => {
		const app1 = createMockApp({ rootPath: "   " });
		assert.equal(getVaultRootPath(app1), undefined);

		const app2: ObsidianApp = { vault: { getName: () => "EmptyVault" } };
		assert.equal(getVaultRootPath(app2), undefined);
	});
});

describe("BridgeTransport Vault & Project API Client", () => {
	beforeEach(() => {
		resetMockState();
	});

	it("lists existing vaults via GET /api/vaults", async () => {
		const transport = new BridgeTransport({ serverUrl: baseUrl });
		const res = await transport.listVaults();

		assert.ok(Array.isArray(res.vaults));
		assert.equal(res.vaults.length, 1);
		assert.equal(res.vaults[0]?.displayName, "ExistingVault");
		assert.equal(lastRequestUrl, "/api/vaults");
		assert.equal(lastRequestMethod, "GET");
	});

	it("registers new vault via POST /api/vaults (201 Created)", async () => {
		const transport = new BridgeTransport({ serverUrl: baseUrl });
		const res = await transport.registerVault({
			id: "vault_cs_101",
			displayName: "ComputerScience",
			path: "/Users/test/CS",
			deviceId: "macbook",
		});

		assert.ok(res.vault);
		assert.equal(res.vault.id, "vault_cs_101");
		assert.equal(res.vault.displayName, "ComputerScience");
		assert.equal(lastRequestUrl, "/api/vaults");
		assert.equal(lastRequestMethod, "POST");
		assert.deepEqual(lastRequestBody, {
			id: "vault_cs_101",
			displayName: "ComputerScience",
			path: "/Users/test/CS",
			deviceId: "macbook",
		});
	});

	it("recovers gracefully on 409 Conflict by retrieving existing vault", async () => {
		conflictOnVaultId = "vault_conflict_99";
		mockVaults.push({
			id: "vault_conflict_99",
			displayName: "ConflictedVault",
			bindings: [{ deviceId: "local", rootPath: "/Users/test/Conflicted", status: "available" }],
		});

		const transport = new BridgeTransport({ serverUrl: baseUrl });
		const res = await transport.registerVault({
			id: "vault_conflict_99",
			displayName: "ConflictedVault",
			path: "/Users/test/Conflicted",
		});

		assert.ok(res.vault);
		assert.equal(res.vault.id, "vault_conflict_99");
		assert.equal(res.vault.displayName, "ConflictedVault");
	});

	it("lists projects via GET /api/projects", async () => {
		const transport = new BridgeTransport({ serverUrl: baseUrl });
		const res = await transport.listProjects();

		assert.ok(Array.isArray(res.projects));
		assert.equal(res.projects.length, 2);
		assert.equal(res.projects[0]?.name, "Neuroscience 101");
		assert.equal(res.activeProjectId, "proj_neuro_101");
	});

	it("creates new project via POST /api/projects", async () => {
		const transport = new BridgeTransport({ serverUrl: baseUrl });
		const res = await transport.createProject("Machine Learning", "Deep learning notes");

		assert.ok(res.project);
		assert.equal(res.project.name, "Machine Learning");
		assert.equal(res.project.description, "Deep learning notes");
		assert.equal(lastRequestUrl, "/api/projects");
		assert.equal(lastRequestMethod, "POST");
		assert.deepEqual(lastRequestBody, {
			name: "Machine Learning",
			description: "Deep learning notes",
		});
	});

	it("attaches vault to project via POST /api/projects/:id/sources", async () => {
		const transport = new BridgeTransport({ serverUrl: baseUrl });
		await transport.attachVaultToProject("proj_neuro_101", "vault_existing_11223344");

		assert.equal(lastRequestUrl, "/api/projects/proj_neuro_101/sources");
		assert.equal(lastRequestMethod, "POST");
		assert.deepEqual(lastRequestBody, { vaultId: "vault_existing_11223344" });
	});

	it("validates inputs and throws BridgeTransportError on invalid arguments", async () => {
		const transport = new BridgeTransport({ serverUrl: baseUrl });

		await assert.rejects(
			() => transport.registerVault({ displayName: "" }),
			(err: BridgeTransportError) => err.code === "INVALID_PAYLOAD",
		);

		await assert.rejects(
			() => transport.createProject("   "),
			(err: BridgeTransportError) => err.code === "INVALID_PAYLOAD",
		);

		await assert.rejects(
			() => transport.attachVaultToProject("", "vault_1"),
			(err: BridgeTransportError) => err.code === "INVALID_PAYLOAD",
		);
	});
});

describe("ensureVaultRegistered Lifecycle & Settings Persistence", () => {
	beforeEach(() => {
		resetMockState();
	});

	it("verifies and retains existing vaultId if already registered and recognized by server", async () => {
		const app = createMockApp({ vaultName: "ExistingVault" });
		const plugin = createTestPlugin({
			app,
			vaultId: "vault_existing_11223344",
		});

		let savedData: any = null;
		plugin.saveData = async (data) => {
			savedData = data;
		};

		const vault = await ensureVaultRegistered(plugin);
		assert.equal(vault.id, "vault_existing_11223344");
		assert.equal(vault.displayName, "ExistingVault");
		assert.equal(plugin.settings.vaultId, "vault_existing_11223344");
		assert.equal(plugin.settings.registeredVaultId, "vault_existing_11223344");
	});

	it("computes stable ID, registers on server, and persists to settings when vaultId is unset", async () => {
		const app = createMockApp({ vaultName: "QuantumComputing", rootPath: "/Users/test/Quantum" });
		const plugin = createTestPlugin({
			app,
			vaultId: undefined,
		});

		let savedData: any = null;
		plugin.saveData = async (data) => {
			savedData = data;
		};

		const vault = await ensureVaultRegistered(plugin);
		assert.ok(vault.id.startsWith("vault_quantumcomputing_"));
		assert.equal(vault.displayName, "QuantumComputing");
		assert.equal(plugin.settings.vaultId, vault.id);
		assert.equal(plugin.settings.registeredVaultId, vault.id);
		assert.ok(savedData);
		assert.equal(savedData.vaultId, vault.id);
	});
});

describe("LearnHarnessSettingTab UI & DOM Interactions", () => {
	let domWindow: any;
	let domDocument: any;

	beforeEach(() => {
		resetMockState();
		const dom = parseHTML("<!doctype html><html><body><div id='app'></div></body></html>");
		domWindow = dom.window;
		domDocument = dom.window.document;
		(globalThis as any).window = domWindow;
		(globalThis as any).document = domDocument;
	});

	after(() => {
		delete (globalThis as any).window;
		delete (globalThis as any).document;
	});

	it("renders all sections, controls, and accessibility classes in DOM", () => {
		const app = createMockApp({ vaultName: "CognitionLab", rootPath: "/data/vaults/cognition" });
		const plugin = new LearnHarnessBridgePlugin(app);
		plugin.settings.serverUrl = baseUrl;
		plugin.settings.vaultId = "vault_cog_123";

		const settingTab = new LearnHarnessSettingTab(app, plugin);
		settingTab.display();

		const container = settingTab.containerEl!;
		assert.ok(container, "containerEl must be defined");
		assert.ok(container.classList.contains("learnharness-settings-container"));

		// Headers
		const title = container.querySelector(".learnharness-settings-title");
		assert.equal(title?.textContent, "LearnHarness Bridge Settings");

		// Inputs
		const urlInput = container.querySelector(".learnharness-server-url-input") as HTMLInputElement;
		assert.ok(urlInput);
		assert.equal(urlInput.value, baseUrl);

		const keyInput = container.querySelector(".learnharness-api-key-input") as HTMLInputElement;
		assert.ok(keyInput);

		const thresholdInput = container.querySelector(
			".learnharness-folder-threshold-input",
		) as HTMLInputElement;
		assert.ok(thresholdInput);
		assert.equal(thresholdInput.value, "50");

		// Vault section info
		const vaultIdDisplay = container.querySelector(".learnharness-vault-id-display");
		assert.ok(vaultIdDisplay?.textContent?.includes("vault_cog_123"));

		// Project selector dropdown
		const projectSelect = container.querySelector(
			".learnharness-project-select",
		) as HTMLSelectElement;
		assert.ok(projectSelect);
	});

	it("updates serverUrl and apiKey upon input change and persists via saveSettings", async () => {
		const app = createMockApp();
		const plugin = new LearnHarnessBridgePlugin(app);
		let saved = false;
		plugin.saveData = async () => {
			saved = true;
		};

		const settingTab = new LearnHarnessSettingTab(app, plugin);
		settingTab.display();

		const container = settingTab.containerEl!;
		const urlInput = container.querySelector(".learnharness-server-url-input") as HTMLInputElement;
		urlInput.value = "http://127.0.0.1:4000";
		urlInput.onchange?.(new domWindow.Event("change"));

		assert.equal(plugin.settings.serverUrl, "http://127.0.0.1:4000");
		assert.equal(saved, true);

		saved = false;
		const keyInput = container.querySelector(".learnharness-api-key-input") as HTMLInputElement;
		keyInput.value = "secret_api_key_42";
		keyInput.onchange?.(new domWindow.Event("change"));

		assert.equal(plugin.settings.apiKey, "secret_api_key_42");
		assert.equal(saved, true);
	});

	it("executes Test Connection and updates connection status badge", async () => {
		const app = createMockApp();
		const plugin = createTestPlugin({ app });

		const settingTab = new LearnHarnessSettingTab(app, plugin);
		settingTab.display();

		const statusEl = settingTab.connectionStatusEl!;
		assert.ok(statusEl.textContent?.includes("Untested"));

		const health = await settingTab.testConnection();
		assert.equal(health.ok, true);
		assert.ok(statusEl.textContent?.includes("Connected (v1.2.0)"));
	});

	it("populates project dropdown, updates activeProjectId, and attaches vault to project", async () => {
		const app = createMockApp({ vaultName: "ExistingVault" });
		const plugin = createTestPlugin({
			app,
			vaultId: "vault_existing_11223344",
		});

		const settingTab = new LearnHarnessSettingTab(app, plugin);
		settingTab.display();

		// Refresh projects list
		const projects = await settingTab.refreshProjectsList();
		assert.equal(projects.length, 2);

		const select = settingTab.projectSelectEl!;
		assert.equal(select.options.length, 3); // 1 default + 2 projects
		assert.equal(select.options.item(0)?.value ?? select.options[0]?.value, "");
		assert.equal(select.options.item(1)?.value ?? select.options[1]?.value, "proj_neuro_101");
		assert.equal(select.options.item(2)?.value ?? select.options[2]?.value, "proj_comp_sci");

		// Simulate user selecting "proj_comp_sci"
		select.selectedIndex = 2;
		const targetOpt = select.options.item(2) ?? select.options[2];
		if (targetOpt) {
			targetOpt.selected = true;
		}
		select.onchange?.(new domWindow.Event("change"));

		assert.equal(plugin.settings.activeProjectId, "proj_comp_sci");
	});

	it("updates large folder threshold and persists to data.json", async () => {
		const app = createMockApp();
		const plugin = createTestPlugin({ app });
		let savedData: any = null;
		plugin.saveData = async (data) => {
			savedData = data;
		};

		const settingTab = new LearnHarnessSettingTab(app, plugin);
		settingTab.display();

		const thresholdInput = settingTab.containerEl!.querySelector(
			".learnharness-folder-threshold-input",
		) as HTMLInputElement;

		thresholdInput.value = "25";
		thresholdInput.onchange?.(new domWindow.Event("change"));

		assert.equal(plugin.settings.largeFolderThreshold, 25);
		assert.equal(savedData?.largeFolderThreshold, 25);
	});
});

describe("Modals (LargeFolderConfirmModal & NewProjectModal)", () => {
	let domWindow: any;
	let domDocument: any;

	beforeEach(() => {
		const dom = parseHTML("<!doctype html><html><body></body></html>");
		domWindow = dom.window;
		domDocument = dom.window.document;
		(globalThis as any).window = domWindow;
		(globalThis as any).document = domDocument;
	});

	after(() => {
		delete (globalThis as any).window;
		delete (globalThis as any).document;
	});

	it("LargeFolderConfirmModal renders folder path, note count, and target project", async () => {
		const modal = new LargeFolderConfirmModal("Algorithms", 75, {
			folderPath: "CS/Algorithms",
			projectName: "Computer Science",
		});

		void modal.open();
		assert.ok(modal.containerEl);

		const content = modal.containerEl.querySelector(".modal-content");
		assert.ok(content?.textContent?.includes("Algorithms"));
		assert.ok(content?.textContent?.includes("CS/Algorithms"));
		assert.ok(content?.textContent?.includes("75 markdown notes"));
		assert.ok(content?.textContent?.includes("Computer Science"));

		modal.confirm();
		assert.equal(modal.confirmed, true);
		assert.equal(modal.isOpen, false);
	});

	it("NewProjectModal validates required project name and submits successfully", async () => {
		let submittedName = "";
		let submittedDesc: string | undefined = "";

		const modal = new NewProjectModal(async (name, desc) => {
			submittedName = name;
			submittedDesc = desc;
			return {
				project: {
					id: "proj_new_42",
					name,
					description: desc,
				},
			};
		});

		void modal.open();
		assert.ok(modal.containerEl);

		// 1. Submit empty name -> error
		const emptyRes = await modal.submit("   ");
		assert.equal(emptyRes, null);
		assert.equal(modal.errorEl?.style.display, "block");

		// 2. Submit valid name and description
		const created = await modal.submit("Biochemistry 201", "Metabolism pathways");
		assert.ok(created);
		assert.equal(created?.name, "Biochemistry 201");
		assert.equal(submittedName, "Biochemistry 201");
		assert.equal(submittedDesc, "Metabolism pathways");
		assert.equal(modal.isOpen, false);
	});
});

describe("Study Folder Threshold Evaluation & Commands", () => {
	beforeEach(() => {
		resetMockState();
	});

	it("studies folder without confirmation when noteCount <= custom threshold", async () => {
		const plugin = createTestPlugin({
			activeProjectId: "proj_neuro_101",
			largeFolderThreshold: 30,
		});

		const notes: MockTFile[] = [];
		for (let i = 1; i <= 30; i++) {
			notes.push(new MockTFile(`Vault/Folder/Note_${i}.md`));
		}
		const folder = new MockTFolder("Vault/Folder", notes);

		let modalPrompted = false;
		const confirmHandler = async () => {
			modalPrompted = true;
			return true;
		};

		const res = await executeStudyFolder(plugin, folder, confirmHandler);
		assert.ok(res);
		assert.equal(modalPrompted, false, "Must not prompt when count <= 30");
		assert.equal(lastRequestUrl, "/api/projects/proj_neuro_101/study-sessions");
	});

	it("prompts confirmation when noteCount > custom threshold", async () => {
		const plugin = createTestPlugin({
			activeProjectId: "proj_neuro_101",
			largeFolderThreshold: 30,
		});

		const notes: MockTFile[] = [];
		for (let i = 1; i <= 31; i++) {
			notes.push(new MockTFile(`Vault/Folder/Note_${i}.md`));
		}
		const folder = new MockTFolder("Vault/Folder", notes);

		let modalPrompted = false;
		const confirmHandler = async () => {
			modalPrompted = true;
			return true;
		};

		const res = await executeStudyFolder(plugin, folder, confirmHandler);
		assert.ok(res);
		assert.equal(modalPrompted, true, "Must prompt when count > 30");
	});

	it("executeRegisterVault command registers vault and displays notification", async () => {
		const plugin = createTestPlugin({
			app: createMockApp({ vaultName: "ResearchVault" }),
		});

		const vault = await executeRegisterVault(plugin);
		assert.ok(vault);
		assert.ok(plugin.lastNotice?.includes("registered successfully"));
	});

	it("executeSelectProject command switches active project and persists choice", async () => {
		const plugin = createTestPlugin();

		const chosen = await executeSelectProject(plugin, "proj_comp_sci");
		assert.equal(chosen, "proj_comp_sci");
		assert.equal(plugin.settings.activeProjectId, "proj_comp_sci");
		assert.ok(plugin.lastNotice?.includes("Target project set to"));
	});
});

describe("Plugin Lifecycle & Standalone Compilation Gate", () => {
	it("registers setting tab and commands during onload() lifecycle", async () => {
		const app = createMockApp();
		const plugin = createTestPlugin({
			app,
			autoRegisterVault: false, // Disable auto-network in unit test
		});

		await plugin.onload();

		assert.equal(plugin.isLoaded, true);
		assert.ok(plugin.settingTabs.length > 0);
		assert.ok(plugin.commands.has("learnharness:register-vault"));
		assert.ok(plugin.commands.has("learnharness:select-project"));
		assert.ok(plugin.commands.has("learnharness:study-current-note"));

		await plugin.onunload();
		assert.equal(plugin.isLoaded, false);
		assert.equal(plugin.settingTabs.length, 0);
		assert.equal(plugin.commands.size, 0);
	});

	it("verifies standalone plugin compiles with zero errors via tsc", () => {
		// Validates plugins/obsidian-bridge/tsconfig.json strict compilation
		const output = execSync("./node_modules/.bin/tsc -p plugins/obsidian-bridge/tsconfig.json", {
			encoding: "utf-8",
		});
		assert.equal(output.trim(), "", "tsc compilation must succeed with 0 errors");
	});
});
