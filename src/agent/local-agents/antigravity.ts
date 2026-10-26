import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { appHeldEnvVars, resolveBinary } from "./binaries.ts";
import type { AdapterProbe, LocalAgentAdapter, OpenRequest } from "./adapter.ts";
import type { LocalRun, RunSession } from "./run.ts";
import type { PromptBlock } from "./transcript.ts";

/**
 * Antigravity via Google's official Antigravity CLI (`agy`), installed by the
 * learner (docs/architecture.md §8.2). Google's binary makes every model
 * request and owns the Google sign-in and its tokens; LearnHarness never
 * reads a token.
 *
 * Isolation: headless stream-json mode, isolated workspace with `.git` and
 * `.agents/agents/lh.md`, only the app's loopback MCP bridge, the app's own
 * system prompt, and scrubbed app-held env vars.
 */

const API: Api = "antigravity-cli";
const PROVIDER = "antigravity";

function knownDirs(): string[] {
	const home = os.homedir();
	let user: string | undefined;
	try {
		user = os.userInfo?.()?.username;
	} catch {
		// In minimal chroot/containers without /etc/passwd, userInfo() can throw ENOENT
	}
	user = user || process.env.USER || path.basename(home);
	return [
		`/etc/profiles/per-user/${user}/bin`,
		path.join(home, ".nix-profile", "bin"),
		"/run/current-system/sw/bin",
		path.join(home, ".antigravity", "bin"),
		path.join(home, ".local", "bin"),
	];
}

export function resolveAntigravityBinary(): Promise<string | undefined> {
	return resolveBinary({
		envVar: "LH_AGY_BIN",
		names: process.platform === "win32" ? ["agy.exe"] : ["agy"],
		knownDirs: knownDirs(),
	});
}

/** Presence only — the token's contents are never read. */
export function antigravityTokenPresent(): Promise<boolean> {
	const home = process.env.GEMINI_HOME ? path.resolve(process.env.GEMINI_HOME) : path.join(os.homedir(), ".gemini");
	const candidates = [
		path.join(home, "antigravity-cli", "antigravity-oauth-token"),
		path.join(home, "jetski-standalone-oauth-token"),
	];
	return Promise.resolve(candidates.some((file) => fs.existsSync(file)));
}

export function antigravityChildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...base };
	for (const name of appHeldEnvVars()) delete env[name];
	return env;
}

function run(binary: string, args: string[], timeout: number): Promise<{ ok: boolean; stdout: string; stderr: string; timedOut: boolean }> {
	return new Promise((resolve) => {
		const child = execFile(
			binary,
			args,
			{ timeout, env: antigravityChildEnv(), windowsHide: true, maxBuffer: 1024 * 1024 },
			(error, stdout, stderr) => {
				const timedOut = Boolean(
					error &&
					((error as { killed?: boolean }).killed ||
					 (error as { code?: string }).code === "ETIMEDOUT" ||
					 (error as { signal?: string }).signal === "SIGTERM")
				);
				resolve({ ok: !error, stdout: String(stdout), stderr: String(stderr), timedOut });
			},
		);
		child.stdin?.on("error", () => {});
		child.stdin?.end();
	});
}

function parseVersion(stdout: string): string | undefined {
	const clean = stdout.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "").replace(/\u001b\[[0-9;]*m/g, "");
	const match = clean.match(/\b\d+\.\d+\S*/);
	return match ? match[0] : clean.trim().split(/\s+/).pop();
}

export function antigravityEffort(level: ThinkingLevel | string | undefined): string[] {
	if (!level || level === "off") return [];
	if (level === "minimal" || level === "low") return ["--effort", "low"];
	if (level === "medium") return ["--effort", "medium"];
	if (level === "high") return ["--effort", "high"];
	if (level === "xhigh") return ["--effort", "xhigh"];
	return [];
}

function catalogModel(id: string, name: string): Model<Api> {
	return {
		id,
		name: name || id,
		api: API,
		provider: PROVIDER,
		baseUrl: "",
		reasoning: true,
		thinkingLevelMap: { off: "off", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: /^gemini/i.test(id) ? 1_048_576 : 200_000,
		maxTokens: 65_536,
	} as Model<Api>;
}

export function extractAgyModelsJson(stdout: string): { models: Array<{ id: string; label?: string }>; error?: string } {
	// First: try line-by-line in reverse (since agy outputs spinner frames on earlier lines and final JSON on last line)
	const lines = stdout.trim().split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]!.trim();
		const start = line.indexOf("{");
		const end = line.lastIndexOf("}");
		if (start >= 0 && end >= start) {
			try {
				const parsed = JSON.parse(line.slice(start, end + 1));
				if (parsed?.status === "ERROR") {
					return { models: [], error: parsed.response || parsed.error || "Antigravity models command returned error status." };
				}
				const rawModels = parsed?.command?.data?.models ?? parsed?.models;
				if (Array.isArray(rawModels)) {
					return { models: rawModels };
				}
			} catch {
				// Keep searching previous lines
			}
		}
	}
	// Fallback: search backwards for {"conversation_id" or first { and slice up to lastIndexOf("}") + 1
	const idx = stdout.lastIndexOf('{"conversation_id"');
	const start = idx >= 0 ? idx : stdout.indexOf("{");
	if (start >= 0) {
		const tail = stdout.slice(start);
		const lastBrace = tail.lastIndexOf("}");
		if (lastBrace >= 0) {
			try {
				const parsed = JSON.parse(tail.slice(0, lastBrace + 1));
				if (parsed?.status === "ERROR") {
					return { models: [], error: parsed.response || parsed.error || "Antigravity models command returned error status." };
				}
				const rawModels = parsed?.command?.data?.models ?? parsed?.models;
				if (Array.isArray(rawModels)) {
					return { models: rawModels };
				}
			} catch {
				// Fall through
			}
		}
	}
	return { models: [] };
}

export async function probeAntigravity(options?: { discoverModels?: boolean; previous?: Model<Api>[] }): Promise<AdapterProbe> {
	const binary = await resolveAntigravityBinary();
	if (!binary) return { installed: false, signedIn: false, models: [] };

	const previous = options?.previous ?? [];
	const versionResult = await run(binary, ["--version"], 15_000);
	if (versionResult.timedOut) {
		return {
			installed: true,
			binary,
			signedIn: await antigravityTokenPresent(),
			models: previous,
			uncertain: true,
			error: "Antigravity CLI did not respond within timeout.",
		};
	}
	const version = versionResult.ok ? parseVersion(versionResult.stdout) : undefined;

	const signedIn = await antigravityTokenPresent();
	if (!signedIn) {
		return {
			installed: true,
			binary,
			...(version ? { version } : {}),
			signedIn: false,
			models: [],
			...(versionResult.ok ? {} : { error: "Antigravity CLI did not start. Reinstall it or update it, then refresh." }),
		};
	}

	const discoverModels = options?.discoverModels ?? true;
	if (!discoverModels || previous.length > 0) {
		return {
			installed: true,
			binary,
			...(version ? { version } : {}),
			signedIn: true,
			usesSubscription: true,
			models: previous,
			...(versionResult.ok ? {} : { error: "Antigravity CLI did not start. Reinstall it or update it, then refresh." }),
		};
	}

	try {
		const modelsResult = await run(binary, ["--output-format", "json", "models"], 30_000);
		if (!modelsResult.ok) {
			const errorMsg = modelsResult.stderr.trim() || modelsResult.stdout.trim() || (modelsResult.timedOut ? "Antigravity models command timed out." : "Antigravity models command failed.");
			const auth = /auth|credential|sign|login/i.test(errorMsg);
			const uncertain = modelsResult.timedOut || !auth;
			return {
				installed: true,
				binary,
				...(version ? { version } : {}),
				signedIn: !auth,
				models: auth ? [] : previous,
				...(uncertain ? { uncertain: true } : {}),
				error: auth ? "Antigravity's Google sign-in is missing or expired. Sign in again." : `Antigravity did not respond: ${errorMsg}`,
			};
		}
		const extraction = extractAgyModelsJson(modelsResult.stdout);
		if (extraction.error) {
			const auth = /auth|credential|sign|login/i.test(extraction.error);
			return {
				installed: true,
				binary,
				...(version ? { version } : {}),
				signedIn: !auth,
				models: auth ? [] : previous,
				...(auth ? {} : { uncertain: true }),
				error: auth ? "Antigravity's Google sign-in is missing or expired. Sign in again." : `Antigravity did not respond: ${extraction.error}`,
			};
		}
		const models = extraction.models.map((m) => catalogModel(m.id, m.label || m.id));
		return {
			installed: true,
			binary,
			...(version ? { version } : {}),
			signedIn: true,
			usesSubscription: true,
			models,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const auth = /auth|credential|sign|login/i.test(message);
		const timedOut = /timeout|timed out|ETIMEDOUT/i.test(message);
		const uncertain = timedOut || !auth;
		return {
			installed: true,
			binary,
			...(version ? { version } : {}),
			signedIn: !auth,
			models: auth ? [] : previous,
			...(uncertain ? { uncertain: true } : {}),
			error: auth ? "Antigravity's Google sign-in is missing or expired. Sign in again." : `Antigravity did not respond: ${message}`,
		};
	}
}

export type LocalAgentDriver = RunSession;
export type LocalAgentOpenOptions = OpenRequest;

export function toAgyContent(blocks: PromptBlock[]): Array<{ type: "text"; text: string }> {
	return blocks.map((block) => ({
		type: "text",
		text: block.type === "image" ? `[image omitted: ${block.mimeType ?? "unknown"}]` : (block.text ?? ""),
	}));
}

export function antigravityLineHandler(run: LocalRun) {
	return (message: Record<string, any>) => {
		if (message.event === "step_update") {
			const step = message.step_update;
			if (!step) return;
			if (step.state === "ERROR") {
				run.fail(String(step.error || step.message || "Antigravity step failed."));
				return;
			}
			if (step.step_type === "agent_response") {
				if (typeof step.thinking_delta === "string" && step.thinking_delta) {
					run.thinking(step.thinking_delta);
				}
				if (typeof step.text_delta === "string" && step.text_delta) {
					run.text(step.text_delta);
				}
			}
			if (step.usage) {
				run.usage({
					input: step.usage.input_tokens ?? 0,
					output: step.usage.output_tokens ?? 0,
					cacheRead: step.usage.cache_read_tokens ?? 0,
				});
			}
			return;
		}
		if (message.event === "result") {
			const result = message.result;
			if (result?.status === "SUCCESS") {
				if (result.usage) {
					run.usage({
						input: result.usage.input_tokens ?? 0,
						output: result.usage.output_tokens ?? 0,
						cacheRead: result.usage.cache_read_tokens ?? 0,
					});
				}
				run.endTurn("stop");
			} else {
				run.fail(String(result?.error || result?.response || "Antigravity request failed."));
			}
			return;
		}
		if (message.event === "error") {
			run.fail(String(message.error?.message || "Antigravity error."));
			return;
		}
	};
}

export async function openAntigravity(run: LocalRun, request: OpenRequest): Promise<RunSession> {
	const workspaceDir = fs.mkdtempSync(path.join(os.homedir(), ".lh-antigravity-"));
	fs.mkdirSync(path.join(workspaceDir, ".git"), { recursive: true });

	const agentDir = path.join(workspaceDir, ".agents", "agents");
	fs.mkdirSync(agentDir, { recursive: true });

	const frontmatterLines: string[] = [
		"---",
		"name: lh",
		"description: LearnHarness isolated agent",
		"mainAgent: true",
		"excludeDefaultComponents: true",
		"inheritCustomizations: false",
		"inheritMcp: false",
	];

	if (request.tools.length > 0) {
		frontmatterLines.push(
			"mcpServers:",
			"  - name: learnharness",
			`    url: "${request.bridge.url}"`,
			"    headers:",
			`      Authorization: "Bearer ${request.bridge.token}"`,
			"    enabledTools:",
			...request.tools.map((t) => `      - ${t.name}`),
		);
	}

	frontmatterLines.push("---", "", "# System Prompt", request.systemPrompt);
	fs.writeFileSync(path.join(agentDir, "lh.md"), frontmatterLines.join("\n") + "\n", { mode: 0o600 });

	const effortLevel = (request as any).effort ?? (request as any).thinkingLevel ?? request.level;
	const effortArgs = antigravityEffort(effortLevel);
	const args = [
		"--input-format", "stream-json",
		"--output-format", "stream-json",
		"-p=",
		"--agent", "lh",
		"--model", request.model.id,
		"--disable-slash-commands",
		...effortArgs,
	];

	const child = spawn(request.binary, args, {
		cwd: workspaceDir,
		env: antigravityChildEnv(),
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});

	let stderr = "";
	let disposed = false;
	const handle = antigravityLineHandler(run);
	let buffer = "";

	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		buffer += chunk;
		let newline: number;
		while ((newline = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (!line) continue;
			const start = line.indexOf("{");
			const end = line.lastIndexOf("}");
			if (start < 0 || end < start) continue;
			let parsed: Record<string, any>;
			try {
				parsed = JSON.parse(line.slice(start, end + 1));
			} catch {
				continue;
			}
			handle(parsed);
		}
	});

	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		stderr = (stderr + chunk).slice(-4000);
	});

	child.on("error", (error) => run.fail(`Antigravity CLI could not start: ${error.message}`));
	child.on("exit", (code) => {
		if (!disposed && !run.closed) {
			run.fail(stderr.trim().split("\n").pop() || `Antigravity CLI exited (${code ?? "signal"}).`);
		}
	});
	child.stdin.on("error", () => { /* surfaced through exit */ });

	return {
		start(prompt: PromptBlock[]) {
			const userTurn = {
				event: "user",
				message: {
					role: "user",
					content: toAgyContent(prompt),
				},
			};
			child.stdin.write(`${JSON.stringify(userTurn)}\n`);
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			try {
				child.stdin.end();
			} catch {
				// Ignore
			}
			child.kill("SIGTERM");
			const force = setTimeout(() => {
				if (child.exitCode === null) {
					child.kill("SIGKILL");
				}
			}, 3_000);
			force.unref();
			try {
				fs.rmSync(workspaceDir, { recursive: true, force: true });
			} catch {
				fs.rm(workspaceDir, { recursive: true, force: true }, () => {});
			}
		},
	};
}

export const antigravityAdapter: LocalAgentAdapter = {
	providerId: PROVIDER,
	surfaceOnArrival: true,
	images: false,
	probe: probeAntigravity,
	open: openAntigravity,
};
