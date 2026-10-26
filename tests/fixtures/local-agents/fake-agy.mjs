#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const args = process.argv.slice(2);
const logFile = process.env.FAKE_AGY_LOG || process.env.FAKE_ACP_LOG;
const log = (entry) => {
	if (logFile) {
		fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
	}
};

if (args.includes("--version")) {
	console.log("1.4.3");
	process.exit(0);
}

if (args.includes("models")) {
	process.stderr.write("⠋ Fetching available models...\n");
	const models = [
		{ id: "gemini-4-argon-medium", label: "Gemini 4 Argon (Medium)" },
		{ id: "gemini-4-argon-high", label: "Gemini 4 Argon (High)" },
		{ id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High)" },
	];
	const data = {
		conversation_id: "",
		status: "SUCCESS",
		response: models.map((m) => `${m.id}\t${m.label}`).join("\n") + "\n",
		duration_seconds: 0,
		num_turns: 0,
		usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
		command: { name: "models", data: { models } },
	};
	process.stdout.write(`${JSON.stringify(data)}\n`);
	process.exit(0);
}

const flag = (name) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};

// Headless stream-json session
const agentFile = path.join(process.cwd(), ".agents", "agents", "lh.md");
let agentConfig = null;
let systemPrompt = "";
if (fs.existsSync(agentFile)) {
	const text = fs.readFileSync(agentFile, "utf8");
	const parts = text.split("---");
	if (parts.length >= 3) {
		agentConfig = parts[1];
		const body = parts.slice(2).join("---").trim();
		const promptPrefix = "# System Prompt";
		systemPrompt = body.startsWith(promptPrefix)
			? body.slice(promptPrefix.length).trim()
			: body;
	}
}

log({
	type: "launch",
	args,
	cwd: process.cwd(),
	cwdEntries: fs.readdirSync(process.cwd()),
	agentConfig,
	systemPrompt,
	env: {
		GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? null,
		DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY ?? null,
		TAVILY_API_KEY: process.env.TAVILY_API_KEY ?? null,
	},
});

let mcpServer = null;
if (agentConfig && agentConfig.includes("url:")) {
	const urlMatch = agentConfig.match(/url:\s*"([^"]+)"/);
	const authMatch = agentConfig.match(/Authorization:\s*"Bearer ([^"]+)"/);
	if (urlMatch) {
		mcpServer = {
			url: urlMatch[1],
			token: authMatch ? authMatch[1] : undefined,
		};
	}
}

const emit = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const convId = "conv_fake_1";
emit({
	event: "init",
	conversation_id: convId,
	init: {
		model: flag("--model") ?? "gemini-4-argon-medium",
		cwd: process.cwd(),
		agent: flag("--agent") ?? "lh",
		tools: ["call_mcp_tool"],
		permission_mode: "always-proceed",
	},
});

async function rpc(body) {
	const response = await fetch(mcpServer.url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			...(mcpServer.token ? { Authorization: `Bearer ${mcpServer.token}` } : {}),
		},
		body: JSON.stringify(body),
	});
	const text = await response.text();
	const contentType = response.headers.get("content-type") ?? "";
	if (contentType.includes("text/event-stream")) {
		const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
		return dataLine ? JSON.parse(dataLine.slice(6)) : undefined;
	}
	return text ? JSON.parse(text) : undefined;
}

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", async (line) => {
	if (!line.trim()) return;
	const message = JSON.parse(line);
	const content = message.message?.content ?? [];
	log({ type: "user", content });
	const text = content.filter((b) => b.type === "text").at(-1)?.text ?? "";

	emit({
		event: "step_update",
		step_update: { conversation_id: convId, step_index: 0, state: "DONE", step_type: "user_input" },
	});

	if (/use the tool/.test(text) && mcpServer) {
		emit({
			event: "step_update",
			step_update: {
				conversation_id: convId,
				step_index: 1,
				state: "ACTIVE",
				step_type: "agent_response",
				thinking_delta: "checking",
			},
		});
		emit({
			event: "step_update",
			step_update: {
				conversation_id: convId,
				step_index: 1,
				state: "DONE",
				step_type: "agent_response",
				duration_seconds: 0.1,
				usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: 5, cache_read_tokens: 0, total_tokens: 15 },
			},
		});
		emit({
			event: "step_update",
			step_update: {
				conversation_id: convId,
				step_index: 2,
				state: "ACTIVE",
				step_type: "tool",
				tool_name: "call_mcp_tool",
				tool_info: {
					name: "call_mcp_tool",
					parameters: {
						Arguments: { topic: "rivers" },
						ServerName: "learnharness",
						ToolName: "lookup",
					},
				},
			},
		});

		await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-agy", version: "1" } } });
		const call = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lookup", arguments: { topic: "rivers" } } });
		log({ type: "tool_result", result: call.result });

		emit({
			event: "step_update",
			step_update: {
				conversation_id: convId,
				step_index: 2,
				state: "DONE",
				step_type: "tool",
				tool_name: "call_mcp_tool",
				duration_seconds: 0.1,
				tool_info: {
					name: "call_mcp_tool",
					parameters: {
						Arguments: { topic: "rivers" },
						ServerName: "learnharness",
						ToolName: "lookup",
					},
					output: call.result.content[0].text,
				},
			},
		});

		const ans = `got: ${call.result.content[0].text}`;
		emit({
			event: "step_update",
			step_update: { conversation_id: convId, step_index: 3, state: "ACTIVE", step_type: "agent_response", text_delta: ans },
		});
		emit({
			event: "step_update",
			step_update: {
				conversation_id: convId,
				step_index: 3,
				state: "DONE",
				step_type: "agent_response",
				duration_seconds: 0.1,
				usage: { input_tokens: 15, output_tokens: 5, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 20 },
			},
		});
		emit({
			event: "result",
			result: {
				conversation_id: convId,
				status: "SUCCESS",
				response: ans,
				duration_seconds: 0.3,
				num_turns: 1,
				usage: { input_tokens: 25, output_tokens: 10, thinking_tokens: 5, cache_read_tokens: 0, total_tokens: 35 },
			},
		});
	} else {
		const ans = `plain blocks=${content.length}`;
		emit({
			event: "step_update",
			step_update: { conversation_id: convId, step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: ans },
		});
		emit({
			event: "step_update",
			step_update: {
				conversation_id: convId,
				step_index: 1,
				state: "DONE",
				step_type: "agent_response",
				duration_seconds: 0.1,
				usage: { input_tokens: 12, output_tokens: 6, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 18 },
			},
		});
		emit({
			event: "result",
			result: {
				conversation_id: convId,
				status: "SUCCESS",
				response: ans,
				duration_seconds: 0.1,
				num_turns: 1,
				usage: { input_tokens: 12, output_tokens: 6, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 18 },
			},
		});
	}
});
