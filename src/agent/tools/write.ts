import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import { resolveAndValidateObsidianPath } from "./fs-shared.ts";

export const writeInput = Type.Object({
	path: Type.String({
		minLength: 1,
		description: "Path to the Markdown file (.md, .markdown, .mdx) inside a configured Obsidian folder.",
	}),
	content: Type.String({
		description: "The complete content to write to the file.",
	}),
});

export type WriteInput = Static<typeof writeInput>;

/**
 * Creates the write tool scoped to configured Obsidian folders.
 * Supports creating new or overwriting existing Markdown files (.md, .markdown, .mdx).
 * Automatically creates parent directories if needed.
 */
export function writeTool(obsidianFolders: readonly string[] = []): AgentTool<typeof writeInput> {
	return {
		name: "write",
		label: "write",
		description:
			"Create or overwrite a Markdown file (.md, .markdown, or .mdx) strictly inside a configured Obsidian folder. " +
			"Automatically creates parent directories if needed. Rejects non-Markdown files and paths outside configured folders.",
		parameters: writeInput,
		execute: serverExecute("write", writeInput, async ({ path: rawPath, content }) => {
			const resolved = await resolveAndValidateObsidianPath(rawPath, obsidianFolders);
			await fs.mkdir(path.dirname(resolved), { recursive: true });
			await fs.writeFile(resolved, content, "utf-8");
			return `Successfully wrote ${Buffer.byteLength(content, "utf-8")} bytes to ${path.basename(resolved)}.`;
		}),
	};
}
