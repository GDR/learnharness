import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "@earendil-works/pi-agent-core";
import { Type, type AssistantMessage } from "@earendil-works/pi-ai";

// Local agent connection — Antigravity through Google's official Antigravity CLI
// (`agy`, docs/architecture.md §8.2), against a scripted stand-in.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-local-antigravity-"));
const fake = fileURLToPath(new URL("./fixtures/local-agents/fake-agy.mjs", import.meta.url));
fs.chmodSync(fake, 0o755);
const logFile = path.join(directory, "agy.log");
const geminiHome = path.join(directory, "gemini");
process.env.LH_DATA_DIR = path.join(directory, "data");
process.env.LH_AUTH_FILE = path.join(directory, "auth.json");
fs.mkdirSync(process.env.LH_DATA_DIR, { recursive: true });
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}");
fs.writeFileSync(path.join(process.env.LH_DATA_DIR, "local-agents.json"), JSON.stringify({ antigravity: { enabled: true, allowBackgroundUse: false } }));
process.env.LH_AGY_BIN = fake;
process.env.GEMINI_HOME = geminiHome;
process.env.FAKE_AGY_LOG = logFile;
process.env.GEMINI_API_KEY = "should-not-leak";
process.env.DEEPGRAM_API_KEY = "should-not-leak";
process.env.TAVILY_API_KEY = "should-not-leak";

await import("../src/server/local-agents.ts");
const { refreshLocalAgents, localAgentStatus, localAgentModels } = await import("../src/agent/local-agents/index.ts");
const { antigravityEffort } = await import("../src/agent/local-agents/antigravity.ts");
const { findRun } = await import("../src/agent/local-agents/run.ts");
const { piEngineForSpec } = await import("../src/agent/models.ts");

after(() => fs.rmSync(directory, { recursive: true, force: true }));

function logEntries(type: string): Array<Record<string, any>> {
	if (!fs.existsSync(logFile)) return [];
	return fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.type === type);
}

test("without Antigravity's own saved sign-in the connection stays off and the CLI is never started", async () => {
	await refreshLocalAgents({ force: true });
	const status = localAgentStatus("antigravity");
	assert.equal(status.installed, true);
	assert.equal(status.signedIn, false);
	assert.equal(status.connected, false);
	assert.equal(logEntries("launch").length, 0);
});

test("signed-in state discovers the model catalog 1-to-1 from agy models and reports the CLI version", async () => {
	fs.mkdirSync(path.join(geminiHome, "antigravity-cli"), { recursive: true });
	fs.writeFileSync(path.join(geminiHome, "antigravity-cli", "antigravity-oauth-token"), "dummy-token-not-read");
	await refreshLocalAgents({ force: true });
	const status = localAgentStatus("antigravity");
	assert.equal(status.installed, true);
	assert.equal(status.signedIn, true);
	assert.equal(status.connected, true);
	assert.equal(status.version, "1.4.3");
	const models = localAgentModels().filter((m) => m.provider === "antigravity");
	assert.deepEqual(models.map((m) => m.id), ["gemini-4-argon-medium", "gemini-4-argon-high", "gemini-3.8-flash-high"]);
	assert.equal(models[0]!.name, "Gemini 4 Argon (Medium)");
});

let executions = 0;
const lookup = {
	name: "lookup", label: "Lookup", description: "Look up the secret word for a topic.",
	parameters: Type.Object({ topic: Type.String() }),
	execute: async (_id: string, params: unknown) => { const args = params as { topic: string }; executions++; return { content: [{ type: "text" as const, text: args.topic === "rivers" ? "OTTER" : "?" }], details: {} }; },
};
let teacher: Agent;

test("a bridged tool call parks the turn and resumes the same agy process with pi's result, with isolated agent config", { timeout: 20_000 }, async () => {
	const before = logEntries("launch").length;
	const engine = piEngineForSpec({ provider: "antigravity", id: "gemini-4-argon-medium", thinkingLevel: "high" }, false);
	teacher = new Agent({ sessionId: "chat-ag", initialState: { systemPrompt: "Teach.", model: engine.model, thinkingLevel: engine.level, tools: [lookup], messages: [] }, streamFn: engine.streamFn });
	await teacher.prompt("please use the tool");
	const messages = teacher.state.messages;
	const call = messages.find((m): m is AssistantMessage => m.role === "assistant" && m.stopReason === "toolUse")!;
	const toolCall = call.content.find((c) => c.type === "toolCall")!;
	assert.equal(toolCall.type === "toolCall" && toolCall.name, "lookup");
	assert.deepEqual(toolCall.type === "toolCall" && toolCall.arguments, { topic: "rivers" });
	assert.deepEqual(call.content.filter((c) => c.type === "thinking").map((c) => c.type === "thinking" && c.thinking), ["checking"]);
	const final = messages.at(-1) as AssistantMessage;
	assert.deepEqual(final.content.map((c) => c.type === "text" && c.text), ["got: OTTER"]);
	assert.equal(executions, 1);

	// One agy process served both steps
	const launches = logEntries("launch").slice(before);
	assert.equal(launches.length, 1);
	const launch = launches[0]!;
	const args = launch.args as string[];
	assert(args.includes("--input-format") && args[args.indexOf("--input-format") + 1] === "stream-json");
	assert(args.includes("--output-format") && args[args.indexOf("--output-format") + 1] === "stream-json");
	assert(args.includes("-p="));
	assert(args.includes("--agent") && args[args.indexOf("--agent") + 1] === "lh");
	assert(args.includes("--model") && args[args.indexOf("--model") + 1] === "gemini-4-argon-medium");
	assert(args.includes("--effort") && args[args.indexOf("--effort") + 1] === "high");
	assert(args.includes("--disable-slash-commands"));

	// Workspace isolation
	assert(launch.cwd.startsWith(os.homedir()));
	assert(launch.cwdEntries.includes(".git"));
	assert(launch.cwdEntries.includes(".agents"));
	assert.match(launch.agentConfig, /excludeDefaultComponents:\s*true/);
	assert.match(launch.agentConfig, /inheritCustomizations:\s*false/);
	assert.match(launch.agentConfig, /inheritMcp:\s*false/);
	assert.match(launch.agentConfig, /Authorization:\s*"Bearer [0-9a-f]{64}"/);
	assert.equal(launch.systemPrompt, "Teach.");
	assert.deepEqual(launch.env, { GEMINI_API_KEY: null, DEEPGRAM_API_KEY: null, TAVILY_API_KEY: null });

	assert.equal(findRun("chat-ag"), undefined, "finished turn releases its process");
});

test("the next learner turn cold-starts a fresh CLI conversation from the transcript", { timeout: 20_000 }, async () => {
	const before = logEntries("launch").length;
	await teacher.prompt("and now?");
	assert.equal(logEntries("launch").length, before + 1);
	const opening = logEntries("user").at(-1)!.content as Array<{ type: string; text?: string }>;
	assert.match(opening[0]!.text!, /conversation so far/);
	const joined = opening.map((b) => b.text ?? "").join("\n");
	assert.match(joined, /please use the tool/);
	assert.match(joined, /lookup/);
	assert.match(joined, /OTTER/);
	assert.equal(opening.at(-1)!.text, "and now?");
	const reply = teacher.state.messages.at(-1) as AssistantMessage;
	assert.deepEqual(reply.content.map((c) => c.type === "text" && c.text), [`plain blocks=${opening.length}`]);
});

test("background work is refused before the CLI starts when background use is off", { timeout: 10_000 }, async () => {
	const launches = logEntries("launch").length;
	const engine = piEngineForSpec({ provider: "antigravity", id: "gemini-4-argon-medium" }, true);
	const result = await engine.streamFn(engine.model, { systemPrompt: "Teach.", messages: [{ role: "user", content: "hi", timestamp: 0 }] } as never, {}).result();
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /background use is off/);
	assert.equal(logEntries("launch").length, launches);
});

test("thinking levels map to --effort", () => {
	assert.deepEqual(antigravityEffort("off"), []);
	assert.deepEqual(antigravityEffort("minimal"), ["--effort", "low"]);
	assert.deepEqual(antigravityEffort("low"), ["--effort", "low"]);
	assert.deepEqual(antigravityEffort("medium"), ["--effort", "medium"]);
	assert.deepEqual(antigravityEffort("high"), ["--effort", "high"]);
	assert.deepEqual(antigravityEffort("xhigh"), ["--effort", "xhigh"]);
});
