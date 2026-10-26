import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { createModels } from "@earendil-works/pi-ai";
import { bootstrapAntigravityEnv, antigravityProvider, ANTIGRAVITY_MODELS } from "@earendil-works/pi-ai/providers/antigravity";
import { AUTH_PROVIDER_KEYS } from "../src/core/auth-keys.ts";
import { providerKeyPresent, keyValue } from "../src/server/keys.ts";
import { catalogProviders } from "../src/server/model-catalog.ts";
import { piModels } from "../src/agent/models.ts";

describe("Antigravity OAuth Provider — Integration & Specifications", () => {
	it("builtinProviders exposes the antigravity provider with 10 models", () => {
		const providers = builtinProviders();
		const provider = providers.find((p) => p.id === "antigravity");
		assert.ok(provider, "antigravity provider must be present in builtinProviders");
		assert.equal(provider.name, "Antigravity");

		const models = provider.getModels();
		assert.equal(models.length, 10, "antigravity must expose exactly 10 models");

		const expectedModelIds = [
			"gemini-4-argon",
			"gemini-3.8-flash",
			"claude-opus-5-5",
			"claude-sonnet-5-5",
			"gemini-3-flash",
			"gemini-3.5-flash-lite",
			"gemini-3.1-flash-lite",
			"gemini-2.5-pro",
			"gemini-2.5-flash",
			"gpt-oss-120b-medium",
		];

		for (const id of expectedModelIds) {
			const model = models.find((m) => m.id === id);
			assert.ok(model, `model ${id} must be in antigravity catalog`);
			assert.equal(model.provider, "antigravity");
			assert.equal(model.api, "google-antigravity");
		}
	});

	it("thinkingLevelMap matches expected tiers for reasoning models", () => {
		const argon = ANTIGRAVITY_MODELS.find((m) => m.id === "gemini-4-argon");
		assert.ok(argon);
		assert.deepEqual(argon.thinkingLevelMap, {
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: null,
			max: null,
		});

		const flash3 = ANTIGRAVITY_MODELS.find((m) => m.id === "gemini-3-flash");
		assert.ok(flash3);
		assert.deepEqual(flash3.thinkingLevelMap, {
			off: null,
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: null,
			max: null,
		});
	});

	it("AUTH_PROVIDER_KEYS includes antigravity in sorted order", () => {
		const entry = AUTH_PROVIDER_KEYS.find((p) => p.id === "antigravity");
		assert.deepEqual(entry, {
			id: "antigravity",
			envVar: "ANTIGRAVITY_OAUTH_TOKEN",
			label: "Antigravity",
		});

		const ids = AUTH_PROVIDER_KEYS.map((p) => p.id);
		const sorted = [...ids].sort((a, b) => a.localeCompare(b));
		assert.deepEqual(ids, sorted, "AUTH_PROVIDER_KEYS must stay sorted");
	});

	describe("auth resolution contract", () => {
		it("resolves from env when ctx.env returns ANTIGRAVITY_OAUTH_TOKEN", async () => {
			const token = "mock-antigravity-token-12345";
			const models = createModels({
				authContext: {
					env: async (name) => (name === "ANTIGRAVITY_OAUTH_TOKEN" ? token : undefined),
					fileExists: async () => false,
				},
			});
			models.setProvider(antigravityProvider());

			const auth = await models.getAuth("antigravity");
			assert.ok(auth);
			assert.equal(auth.source, "ANTIGRAVITY_OAUTH_TOKEN");
			assert.equal(auth.auth.apiKey, token);
		});

		it("resolves stored credentials directly", async () => {
			const models = createModels();
			const provider = antigravityProvider();
			models.setProvider(provider);

			const resolved = await provider.auth?.apiKey?.resolve?.({
				ctx: { env: async () => undefined, fileExists: async () => false } as any,
				credential: { type: "api_key", key: "stored-secret-key-999", env: {} },
				signal: new AbortController().signal,
			});

			assert.ok(resolved);
			assert.equal(resolved.source, "stored credential");
			assert.equal(resolved.auth.apiKey, "stored-secret-key-999");
		});

		it("resolves local-antigravity-oauth when token file exists", async () => {
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ag-auth-"));
			const tokenFile = path.join(tmpDir, "fake-token.json");
			fs.writeFileSync(tokenFile, JSON.stringify({ token: { access_token: "test-access" } }));

			const oldTokenFile = process.env.ANTIGRAVITY_OAUTH_TOKEN_FILE;
			process.env.ANTIGRAVITY_OAUTH_TOKEN_FILE = tokenFile;

			try {
				const provider = antigravityProvider();
				const resolved = await provider.auth?.apiKey?.resolve?.({
					ctx: { env: async () => undefined, fileExists: async () => false } as any,
					credential: undefined,
					signal: new AbortController().signal,
				});

				assert.ok(resolved);
				assert.equal(resolved.source, "local-oauth-file");
				assert.equal(resolved.auth.apiKey, "local-antigravity-oauth");
			} finally {
				if (oldTokenFile === undefined) delete process.env.ANTIGRAVITY_OAUTH_TOKEN_FILE;
				else process.env.ANTIGRAVITY_OAUTH_TOKEN_FILE = oldTokenFile;
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});
	});

	describe("bootstrapAntigravityEnv behavior", () => {
		it("populates process.env.ANTIGRAVITY_OAUTH_TOKEN when token file exists", () => {
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ag-bootstrap-"));
			const tokenFile = path.join(tmpDir, "token.json");
			fs.writeFileSync(tokenFile, JSON.stringify({ token: { access_token: "tok" } }));

			const savedEnv = process.env.ANTIGRAVITY_OAUTH_TOKEN;
			const savedFile = process.env.ANTIGRAVITY_OAUTH_TOKEN_FILE;

			delete process.env.ANTIGRAVITY_OAUTH_TOKEN;
			process.env.ANTIGRAVITY_OAUTH_TOKEN_FILE = tokenFile;

			try {
				bootstrapAntigravityEnv();
				assert.equal(process.env.ANTIGRAVITY_OAUTH_TOKEN, "local-antigravity-oauth");
			} finally {
				if (savedEnv === undefined) delete process.env.ANTIGRAVITY_OAUTH_TOKEN;
				else process.env.ANTIGRAVITY_OAUTH_TOKEN = savedEnv;
				if (savedFile === undefined) delete process.env.ANTIGRAVITY_OAUTH_TOKEN_FILE;
				else process.env.ANTIGRAVITY_OAUTH_TOKEN_FILE = savedFile;
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it("respects LH_IGNORE_ENV_KEYS=1 and does NOT populate", () => {
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-ag-ignore-"));
			const tokenFile = path.join(tmpDir, "token.json");
			fs.writeFileSync(tokenFile, JSON.stringify({ token: { access_token: "tok" } }));

			const savedEnv = process.env.ANTIGRAVITY_OAUTH_TOKEN;
			const savedFile = process.env.ANTIGRAVITY_OAUTH_TOKEN_FILE;
			const savedIgnore = process.env.LH_IGNORE_ENV_KEYS;

			delete process.env.ANTIGRAVITY_OAUTH_TOKEN;
			process.env.ANTIGRAVITY_OAUTH_TOKEN_FILE = tokenFile;
			process.env.LH_IGNORE_ENV_KEYS = "1";

			try {
				bootstrapAntigravityEnv();
				assert.equal(process.env.ANTIGRAVITY_OAUTH_TOKEN, undefined);
			} finally {
				if (savedEnv === undefined) delete process.env.ANTIGRAVITY_OAUTH_TOKEN;
				else process.env.ANTIGRAVITY_OAUTH_TOKEN = savedEnv;
				if (savedFile === undefined) delete process.env.ANTIGRAVITY_OAUTH_TOKEN_FILE;
				else process.env.ANTIGRAVITY_OAUTH_TOKEN_FILE = savedFile;
				if (savedIgnore === undefined) delete process.env.LH_IGNORE_ENV_KEYS;
				else process.env.LH_IGNORE_ENV_KEYS = savedIgnore;
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});
	});

	describe("LearnHarness catalog federation & providerKeyPresent", () => {
		it("providerKeyPresent and catalogProviders reflect ANTIGRAVITY_OAUTH_TOKEN presence", () => {
			const saved = process.env.ANTIGRAVITY_OAUTH_TOKEN;
			try {
				process.env.ANTIGRAVITY_OAUTH_TOKEN = "local-antigravity-oauth";
				assert.equal(providerKeyPresent("antigravity"), true);
				assert.equal(keyValue("ANTIGRAVITY_OAUTH_TOKEN"), "local-antigravity-oauth");

				const row = catalogProviders().find((p) => p.id === "antigravity");
				assert.ok(row);
				assert.equal(row.keyPresent, true);
				assert.equal(row.envVar, "ANTIGRAVITY_OAUTH_TOKEN");

				const model = piModels().getModel("antigravity", "gemini-4-argon");
				assert.ok(model);
				assert.equal(model.id, "gemini-4-argon");
				assert.equal(model.name, "Gemini 4 Argon");
			} finally {
				if (saved === undefined) delete process.env.ANTIGRAVITY_OAUTH_TOKEN;
				else process.env.ANTIGRAVITY_OAUTH_TOKEN = saved;
			}
		});
	});

	describe("streamSimple offline onPayload hook", () => {
		it("intercepts payload with correct project and model before wire fetch", async () => {
			const provider = antigravityProvider();
			const model = provider.getModels().find((m) => m.id === "gemini-4-argon");
			assert.ok(model);

			let reached = 0;
			let capturedPayload: any = null;
			const sentinel = "LH_OFFLINE_TEST_SENTINEL";

			const result = await provider.streamSimple(
				model,
				{ messages: [{ role: "user", content: "Test prompt", timestamp: 0 }] } as any,
				{
					apiKey: "mock-token-for-test",
					onPayload(payload: any) {
						reached++;
						capturedPayload = payload;
						throw new Error(sentinel);
					},
				},
			).result();

			assert.equal(reached, 1, "onPayload hook must be reached exactly once");
			assert.equal(result.stopReason, "error");
			assert.match(result.errorMessage ?? "", new RegExp(sentinel));
			assert.ok(capturedPayload, "payload must be captured");
			assert.equal(capturedPayload.model, "gemini-4-argon-medium");
			assert.equal(capturedPayload.userAgent, "antigravity");
			assert.ok(capturedPayload.request?.contents);
		});
	});
});
