/**
 * Comprehensive Unit and Integration Tests for LearnHarness Obsidian Bridge Plugin.
 *
 * Verifies Milestone E Slice 1 (F30 / PR E.1):
 * - Manifest validity and required Obsidian plugin fields.
 * - Loopback and transport security validation.
 * - BridgeTransport health check against mock server (200 OK vs connection refused vs timeout).
 * - BridgeTransport authenticated headers (Authorization: Bearer <key> and x-api-key).
 * - Command payload construction, validation, and error handling.
 * - Plugin lifecycle methods (onload, onunload, settings load/save, command registration).
 */

import { describe, it, before, after } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";

import {
	isLoopbackUrl,
	BridgeTransport,
	BridgeTransportError,
} from "../plugins/obsidian-bridge/src/transport.ts";
import { LearnHarnessBridgePlugin } from "../plugins/obsidian-bridge/src/main.ts";
import type {
	BridgeSettings,
	StudyNoteCommandPayload,
	PluginManifest,
} from "../plugins/obsidian-bridge/src/types.ts";

describe("Obsidian Bridge Manifest & Plugin Scaffold", () => {
	const pluginDir = path.join(process.cwd(), "plugins", "obsidian-bridge");

	it("manifest.json exists and contains all required Obsidian fields", () => {
		const manifestPath = path.join(pluginDir, "manifest.json");
		assert.ok(fs.existsSync(manifestPath), "manifest.json must exist");

		const raw = fs.readFileSync(manifestPath, "utf-8");
		const manifest = JSON.parse(raw) as PluginManifest;

		assert.equal(manifest.id, "learnharness-bridge");
		assert.equal(manifest.name, "LearnHarness Bridge");
		assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
		assert.match(manifest.minAppVersion, /^\d+\.\d+\.\d+$/);
		assert.ok(manifest.description.length > 10);
		assert.equal(manifest.author, "LearnHarness");
		assert.equal(manifest.isDesktopOnly, true);
	});

	it("package.json exists with valid build script and metadata", () => {
		const pkgPath = path.join(pluginDir, "package.json");
		assert.ok(fs.existsSync(pkgPath), "package.json must exist");

		const raw = fs.readFileSync(pkgPath, "utf-8");
		const pkg = JSON.parse(raw) as { name: string; private: boolean; scripts: { build: string } };

		assert.equal(pkg.name, "learnharness-obsidian-bridge");
		assert.equal(pkg.private, true);
		assert.ok(pkg.scripts.build.includes("tsc"));
	});

	it("tsconfig.json exists with strict module resolution", () => {
		const tsconfigPath = path.join(pluginDir, "tsconfig.json");
		assert.ok(fs.existsSync(tsconfigPath), "tsconfig.json must exist");

		const raw = fs.readFileSync(tsconfigPath, "utf-8");
		const tsconfig = JSON.parse(raw) as { compilerOptions: { strict: boolean; moduleResolution: string } };

		assert.equal(tsconfig.compilerOptions.strict, true);
		assert.equal(tsconfig.compilerOptions.moduleResolution, "bundler");
	});
});

describe("BridgeTransport Loopback & Security Validation", () => {
	it("correctly identifies loopback addresses", () => {
		assert.equal(isLoopbackUrl("http://127.0.0.1:3000"), true);
		assert.equal(isLoopbackUrl("http://localhost:3000"), true);
		assert.equal(isLoopbackUrl("http://127.0.0.2:8080"), true);
		assert.equal(isLoopbackUrl("http://[::1]:3000"), true);

		assert.equal(isLoopbackUrl("https://learnharness.app"), false);
		assert.equal(isLoopbackUrl("http://192.168.1.50:3000"), false);
		assert.equal(isLoopbackUrl("not-a-valid-url"), false);
	});

	it("rejects invalid serverUrl or unsupported protocol", () => {
		assert.throws(
			() => new BridgeTransport({ serverUrl: "not-a-url" }),
			(err: unknown) => err instanceof BridgeTransportError && err.code === "INVALID_URL",
		);

		assert.throws(
			() => new BridgeTransport({ serverUrl: "ftp://127.0.0.1:21" }),
			(err: unknown) => err instanceof BridgeTransportError && err.code === "INVALID_PROTOCOL",
		);
	});

	it("rejects insecure unencrypted HTTP for remote endpoints", () => {
		assert.throws(
			() => new BridgeTransport({ serverUrl: "http://example.com:3000", apiKey: "secret" }),
			(err: unknown) => err instanceof BridgeTransportError && err.code === "SECURITY_VIOLATION",
		);
	});

	it("rejects remote endpoints without credentials", () => {
		assert.throws(
			() => new BridgeTransport({ serverUrl: "https://example.com" }),
			(err: unknown) => err instanceof BridgeTransportError && err.code === "AUTHENTICATION_REQUIRED",
		);
	});

	it("accepts remote HTTPS endpoints when apiKey credentials are provided", () => {
		const transport = new BridgeTransport({
			serverUrl: "https://example.com",
			apiKey: "valid-api-key",
		});
		assert.equal(transport.getSettings().apiKey, "valid-api-key");
	});

	it("accepts loopback URLs without credentials for local development", () => {
		const transport = new BridgeTransport({ serverUrl: "http://127.0.0.1:3000" });
		assert.equal(transport.getSettings().serverUrl, "http://127.0.0.1:3000");
	});
});

describe("BridgeTransport Health Check, Authenticated Headers & Error Handling", () => {
	let server: http.Server;
	let serverPort = 0;
	let lastReceivedHeaders: http.IncomingHttpHeaders = {};
	let lastReceivedBody: unknown = null;
	let lastReceivedUrl: string | undefined = undefined;
	let lastReceivedMethod: string | undefined = undefined;

	let routeHandler: (req: http.IncomingMessage, res: http.ServerResponse) => boolean = () => false;

	before(async () => {
		server = http.createServer((req, res) => {
			lastReceivedHeaders = req.headers;
			lastReceivedUrl = req.url;
			lastReceivedMethod = req.method;

			let body = "";
			req.on("data", (chunk: Buffer) => {
				body += chunk.toString();
			});

			req.on("end", () => {
				try {
					lastReceivedBody = body.length > 0 ? JSON.parse(body) : null;
				} catch {
					lastReceivedBody = body;
				}

				if (routeHandler(req, res)) {
					return;
				}

				res.statusCode = 404;
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify({ error: "Not found" }));
			});
		});

		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", () => {
				const addr = server.address() as { port: number };
				serverPort = addr.port;
				resolve();
			});
		});
	});

	after(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	it("returns 200 OK health status from /api/health", async () => {
		routeHandler = (req, res) => {
			if (req.url === "/api/health" && req.method === "GET") {
				res.statusCode = 200;
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify({ ok: true, version: "1.0.0", activeProject: "proj_default" }));
				return true;
			}
			return false;
		};

		const transport = new BridgeTransport({
			serverUrl: `http://127.0.0.1:${serverPort}`,
		});

		const health = await transport.checkHealth();
		assert.equal(health.ok, true);
		assert.equal(health.version, "1.0.0");
		assert.equal(health.activeProject, "proj_default");
	});

	it("falls back to /api/projects/active when /api/health returns 404", async () => {
		routeHandler = (req, res) => {
			if (req.url === "/api/projects/active" && req.method === "GET") {
				res.statusCode = 200;
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify({ activeProjectId: "proj_fallback", activeProject: { name: "Fallback Project" } }));
				return true;
			}
			return false;
		};

		const transport = new BridgeTransport({
			serverUrl: `http://127.0.0.1:${serverPort}`,
		});

		const health = await transport.checkHealth();
		assert.equal(health.ok, true);
		assert.equal(health.activeProject, "Fallback Project");
	});

	it("sends both Authorization: Bearer and x-api-key headers when apiKey is present", async () => {
		routeHandler = (req, res) => {
			if (req.url === "/api/health" && req.method === "GET") {
				res.statusCode = 200;
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify({ ok: true }));
				return true;
			}
			return false;
		};

		const transport = new BridgeTransport({
			serverUrl: `http://127.0.0.1:${serverPort}`,
			apiKey: "test-auth-token-12345",
		});

		await transport.checkHealth();

		assert.equal(lastReceivedHeaders["authorization"], "Bearer test-auth-token-12345");
		assert.equal(lastReceivedHeaders["x-api-key"], "test-auth-token-12345");
		assert.equal(lastReceivedHeaders["accept"], "application/json");
	});

	it("does not send authorization headers when apiKey is omitted", async () => {
		routeHandler = (req, res) => {
			if (req.url === "/api/health" && req.method === "GET") {
				res.statusCode = 200;
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify({ ok: true }));
				return true;
			}
			return false;
		};

		const transport = new BridgeTransport({
			serverUrl: `http://127.0.0.1:${serverPort}`,
		});

		await transport.checkHealth();

		assert.equal(lastReceivedHeaders["authorization"], undefined);
		assert.equal(lastReceivedHeaders["x-api-key"], undefined);
	});

	it("handles connection refused errors with descriptive message", async () => {
		// Use an unbound loopback port
		const unusedPort = 58999;
		const transport = new BridgeTransport({
			serverUrl: `http://127.0.0.1:${unusedPort}`,
		});

		await assert.rejects(
			async () => transport.checkHealth(),
			(err: unknown) => {
				assert.ok(err instanceof BridgeTransportError);
				assert.equal(err.code, "ECONNREFUSED");
				assert.match(err.message, /Connection refused/i);
				assert.match(err.message, /Ensure LearnHarness is running/i);
				return true;
			},
		);

		// With throwOnError: false
		const graceful = await transport.checkHealth({ throwOnError: false });
		assert.equal(graceful.ok, false);
		assert.match(graceful.error ?? "", /Connection refused/i);
	});

	it("handles fetch timeouts with descriptive message", async () => {
		routeHandler = (_req, _res) => {
			// Intentionally never respond to trigger timeout
			return true;
		};

		const transport = new BridgeTransport({
			serverUrl: `http://127.0.0.1:${serverPort}`,
		});

		await assert.rejects(
			async () => transport.checkHealth({ timeoutMs: 50 }),
			(err: unknown) => {
				assert.ok(err instanceof BridgeTransportError);
				assert.equal(err.code, "ETIMEDOUT");
				assert.match(err.message, /timed out after 50ms/i);
				return true;
			},
		);

		// With throwOnError: false
		const graceful = await transport.checkHealth({ timeoutMs: 50, throwOnError: false });
		assert.equal(graceful.ok, false);
		assert.match(graceful.error ?? "", /timed out after 50ms/i);
	});

	it("handles HTTP 401 Unauthorized with descriptive error", async () => {
		routeHandler = (req, res) => {
			if (req.url === "/api/health") {
				res.statusCode = 401;
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify({ error: "Invalid API key" }));
				return true;
			}
			return false;
		};

		const transport = new BridgeTransport({
			serverUrl: `http://127.0.0.1:${serverPort}`,
		});

		await assert.rejects(
			async () => transport.checkHealth(),
			(err: unknown) => {
				assert.ok(err instanceof BridgeTransportError);
				assert.equal(err.status, 401);
				assert.equal(err.code, "UNAUTHORIZED");
				assert.match(err.message, /Unauthorized \(401\)/i);
				return true;
			},
		);
	});

	it("handles HTTP 403 Forbidden with descriptive error", async () => {
		routeHandler = (req, res) => {
			if (req.url === "/api/health") {
				res.statusCode = 403;
				res.setHeader("Content-Type", "application/json");
				res.end(JSON.stringify({ error: "Access denied" }));
				return true;
			}
			return false;
		};

		const transport = new BridgeTransport({
			serverUrl: `http://127.0.0.1:${serverPort}`,
		});

		await assert.rejects(
			async () => transport.checkHealth(),
			(err: unknown) => {
				assert.ok(err instanceof BridgeTransportError);
				assert.equal(err.status, 403);
				assert.equal(err.code, "FORBIDDEN");
				assert.match(err.message, /Forbidden \(403\)/i);
				return true;
			},
		);
	});

	it("handles HTTP 404 Not Found when health endpoints are absent", async () => {
		routeHandler = (_req, res) => {
			res.statusCode = 404;
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ error: "Endpoint not found" }));
			return true;
		};

		const transport = new BridgeTransport({
			serverUrl: `http://127.0.0.1:${serverPort}`,
		});

		await assert.rejects(
			async () => transport.checkHealth(),
			(err: unknown) => {
				assert.ok(err instanceof BridgeTransportError);
				assert.equal(err.status, 404);
				assert.equal(err.code, "NOT_FOUND");
				assert.match(err.message, /Not Found \(404\)/i);
				return true;
			},
		);
	});
});

describe("BridgeTransport Command Payloads & API Dispatches", () => {
	let server: http.Server;
	let serverPort = 0;
	let lastReceivedUrl: string | undefined = undefined;
	let lastReceivedBody: unknown = null;

	before(async () => {
		server = http.createServer((req, res) => {
			lastReceivedUrl = req.url;
			let body = "";
			req.on("data", (chunk: Buffer) => {
				body += chunk.toString();
			});
			req.on("end", () => {
				try {
					lastReceivedBody = body ? JSON.parse(body) : null;
				} catch {
					lastReceivedBody = body;
				}

				if (req.url?.includes("/study-sessions") && req.method === "POST") {
					res.statusCode = 200;
					res.setHeader("Content-Type", "application/json");
					res.end(JSON.stringify({ sessionId: "sess_study_abc_123" }));
					return;
				}

				if (req.url?.includes("/ask") && req.method === "POST") {
					res.statusCode = 200;
					res.setHeader("Content-Type", "application/json");
					res.end(JSON.stringify({ answer: "This is the generated answer." }));
					return;
				}

				res.statusCode = 404;
				res.end(JSON.stringify({ error: "Not found" }));
			});
		});

		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", () => {
				const addr = server.address() as { port: number };
				serverPort = addr.port;
				resolve();
			});
		});
	});

	after(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	it("postStudyNote validates required payload fields", async () => {
		const transport = new BridgeTransport({
			serverUrl: `http://127.0.0.1:${serverPort}`,
		});

		await assert.rejects(
			async () => transport.postStudyNote(null as unknown as StudyNoteCommandPayload),
			/Payload must be a valid object/i,
		);

		await assert.rejects(
			async () =>
				transport.postStudyNote({
					vaultName: "",
					filePath: "test.md",
					content: "# Title",
				}),
			/vaultName must be a non-empty string/i,
		);

		await assert.rejects(
			async () =>
				transport.postStudyNote({
					vaultName: "Research",
					filePath: "",
					content: "# Title",
				}),
			/filePath must be a non-empty string/i,
		);
	});

	it("postStudyNote routes to project-scoped endpoint and sends payload", async () => {
		const transport = new BridgeTransport({
			serverUrl: `http://127.0.0.1:${serverPort}`,
			activeProjectId: "proj_research_99",
			vaultId: "vault_obsidian_01",
		});

		const payload: StudyNoteCommandPayload = {
			vaultName: "ResearchVault",
			filePath: "Quantum/Entanglement.md",
			content: "# Quantum Entanglement\nBell inequality notes.",
			selection: "Bell inequality notes.",
			heading: "Quantum Entanglement",
		};

		const result = await transport.postStudyNote(payload);

		assert.equal(lastReceivedUrl, "/api/projects/proj_research_99/study-sessions");
		assert.deepEqual(lastReceivedBody, {
			vaultName: "ResearchVault",
			filePath: "Quantum/Entanglement.md",
			content: "# Quantum Entanglement\nBell inequality notes.",
			selection: "Bell inequality notes.",
			heading: "Quantum Entanglement",
			vaultId: "vault_obsidian_01",
		});
		assert.equal(result.sessionId, "sess_study_abc_123");
	});

	it("postStudyNote defaults to active project endpoint when activeProjectId is omitted", async () => {
		const transport = new BridgeTransport({
			serverUrl: `http://127.0.0.1:${serverPort}`,
		});

		const payload: StudyNoteCommandPayload = {
			vaultName: "DefaultVault",
			filePath: "Index.md",
			content: "Index content",
		};

		const result = await transport.postStudyNote(payload);

		assert.equal(lastReceivedUrl, "/api/projects/active/study-sessions");
		assert.equal(result.sessionId, "sess_study_abc_123");
	});

	it("postAskQuestion validates question and routes correctly", async () => {
		const transport = new BridgeTransport({
			serverUrl: `http://127.0.0.1:${serverPort}`,
			activeProjectId: "proj_math_12",
			vaultId: "vault_02",
		});

		await assert.rejects(
			async () => transport.postAskQuestion("   "),
			/question must be a non-empty string/i,
		);

		const result = await transport.postAskQuestion("What is Bell's Theorem?", {
			sourceDoc: "Quantum/Entanglement.md",
		});

		assert.equal(lastReceivedUrl, "/api/projects/proj_math_12/ask");
		assert.deepEqual(lastReceivedBody, {
			question: "What is Bell's Theorem?",
			context: { sourceDoc: "Quantum/Entanglement.md" },
			vaultId: "vault_02",
		});
		assert.equal(result.answer, "This is the generated answer.");
	});
});

describe("LearnHarnessBridgePlugin Lifecycle & Commands", () => {
	it("initializes plugin with defaults and structural contracts", () => {
		const plugin = new LearnHarnessBridgePlugin();

		assert.equal(plugin.isLoaded, false);
		assert.equal(plugin.manifest.id, "learnharness-bridge");
		assert.equal(plugin.settings.serverUrl, "http://127.0.0.1:3000");
		assert.ok(plugin.transport instanceof BridgeTransport);
		assert.equal(plugin.commands.size, 0);
	});

	it("executes onload lifecycle: loads settings, registers status bar, and registers commands", async () => {
		const plugin = new LearnHarnessBridgePlugin();

		await plugin.onload();

		assert.equal(plugin.isLoaded, true);
		assert.ok(plugin.statusBarItem !== undefined);
		assert.equal((plugin.statusBarItem as { text?: string }).text, "LearnHarness: Ready");

		assert.ok(plugin.commands.has("learnharness:check-health"));
		assert.ok(plugin.commands.has("learnharness:study-current-note"));
		assert.ok(plugin.commands.has("learnharness:ask-about-selection"));
	});

	it("updates settings dynamically and persists via saveSettings", async () => {
		const plugin = new LearnHarnessBridgePlugin();
		await plugin.onload();

		const updatedSettings: Partial<BridgeSettings> = {
			serverUrl: "http://127.0.0.1:4500",
			apiKey: "new-key-123",
			activeProjectId: "proj_science",
		};

		await plugin.saveSettings(updatedSettings);

		assert.equal(plugin.settings.serverUrl, "http://127.0.0.1:4500");
		assert.equal(plugin.settings.apiKey, "new-key-123");
		assert.equal(plugin.settings.activeProjectId, "proj_science");
		assert.equal(plugin.transport.getSettings().apiKey, "new-key-123");
	});

	it("executes onunload lifecycle: removes status bar item and clears commands", async () => {
		const plugin = new LearnHarnessBridgePlugin();
		await plugin.onload();

		assert.equal(plugin.isLoaded, true);
		assert.ok(plugin.commands.size > 0);

		await plugin.onunload();

		assert.equal(plugin.isLoaded, false);
		assert.equal(plugin.statusBarItem, undefined);
		assert.equal(plugin.commands.size, 0);
	});
});
