import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import { resolveAndValidateObsidianPath, type ObsidianToolScopeInput } from "./fs-shared.ts";

export const editInput = Type.Object({
	path: Type.String({
		minLength: 1,
		description: "Path to the Markdown file (.md, .markdown, .mdx) inside a configured Obsidian folder or attached project source.",
	}),
	oldText: Type.String({
		minLength: 1,
		description: "The exact text to replace. Must match verbatim (including indentation and newlines).",
	}),
	newText: Type.String({
		description: "The replacement text.",
	}),
	multiple: Type.Optional(
		Type.Boolean({
			description: "If true, replace all occurrences of oldText instead of requiring a unique match. Default: false.",
		}),
	),
});

export type EditInput = Static<typeof editInput>;

/**
 * Creates the edit tool scoped to configured Obsidian folders or attached project sources.
 * Modifies existing Markdown files (.md, .markdown, .mdx) by performing exact text replacements.
 */
export function editTool(scope: ObsidianToolScopeInput = []): AgentTool<typeof editInput> {
	return {
		name: "edit",
		label: "edit",
		description:
			"Edit an existing Markdown file (.md, .markdown, or .mdx) strictly inside a configured Obsidian folder or attached project source by replacing exact text. " +
			"oldText must match verbatim, including indentation and newlines. Fails if oldText is not found or matches multiple times without multiple: true.",
		parameters: editInput,
		execute: serverExecute("edit", editInput, async ({ path: rawPath, oldText, newText, multiple }) => {
			const resolved = await resolveAndValidateObsidianPath(rawPath, scope);
			let current: string;
			try {
				current = await fs.readFile(resolved, "utf-8");
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") {
					throw new Error(`File not found: ${rawPath}`);
				}
				throw err;
			}

			if (!current.includes(oldText)) {
				throw new Error(`oldText not found in ${path.basename(resolved)}. Ensure exact match including whitespace and newlines.`);
			}

			const count = current.split(oldText).length - 1;
			if (count > 1 && !multiple) {
				throw new Error(`oldText matches ${count} times in ${path.basename(resolved)}. Provide more surrounding context to match uniquely, or set multiple: true.`);
			}

			const updated = multiple ? current.split(oldText).join(newText) : current.replace(oldText, newText);
			await fs.writeFile(resolved, updated, "utf-8");
			return `Successfully replaced ${count} occurrence(s) in ${path.basename(resolved)}.`;
		}),
	};
}
