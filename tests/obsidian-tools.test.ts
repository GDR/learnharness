import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { writeTool } from "../src/agent/tools/write.ts";
import { editTool } from "../src/agent/tools/edit.ts";
import { resolveAndValidateObsidianPath } from "../src/agent/tools/fs-shared.ts";
import { toolActivityLabel } from "../src/core/pending.ts";

describe("Obsidian tools — write & edit scoped to Obsidian folders", () => {
	let tempBase: string;
	let vaultA: string;
	let vaultB: string;
	let outsideDir: string;

	before(async () => {
		tempBase = await fs.mkdtemp(path.join(os.tmpdir(), "lh-obsidian-test-"));
		vaultA = path.join(tempBase, "vault-a");
		vaultB = path.join(tempBase, "vault-b");
		outsideDir = path.join(tempBase, "outside");

		await fs.mkdir(vaultA, { recursive: true });
		await fs.mkdir(vaultB, { recursive: true });
		await fs.mkdir(outsideDir, { recursive: true });
	});

	after(async () => {
		if (tempBase) {
			await fs.rm(tempBase, { recursive: true, force: true });
		}
	});

	describe("resolveAndValidateObsidianPath", () => {
		it("rejects when obsidianFolders is empty or undefined", async () => {
			await assert.rejects(
				() => resolveAndValidateObsidianPath(path.join(vaultA, "note.md"), []),
				/No Obsidian folders are configured in Settings/,
			);
			await assert.rejects(
				() => resolveAndValidateObsidianPath(path.join(vaultA, "note.md"), undefined),
				/No Obsidian folders are configured in Settings/,
			);
		});

		it("rejects empty or whitespace path", async () => {
			await assert.rejects(
				() => resolveAndValidateObsidianPath("", [vaultA]),
				/Path must not be empty/,
			);
			await assert.rejects(
				() => resolveAndValidateObsidianPath("   ", [vaultA]),
				/Path must not be empty/,
			);
		});

		it("accepts allowed extensions .md, .markdown, .mdx (case-insensitive)", async () => {
			const md = await resolveAndValidateObsidianPath("note1.md", [vaultA]);
			assert.equal(md, path.join(vaultA, "note1.md"));

			const markdown = await resolveAndValidateObsidianPath("note2.markdown", [vaultA]);
			assert.equal(markdown, path.join(vaultA, "note2.markdown"));

			const mdx = await resolveAndValidateObsidianPath("note3.mdx", [vaultA]);
			assert.equal(mdx, path.join(vaultA, "note3.mdx"));

			const uppercase = await resolveAndValidateObsidianPath("note4.MD", [vaultA]);
			assert.equal(uppercase, path.join(vaultA, "note4.MD"));
		});

		it("rejects non-markdown extensions (.ts, .json, .txt, extensionless)", async () => {
			await assert.rejects(
				() => resolveAndValidateObsidianPath("code.ts", [vaultA]),
				/File extension '\.ts' is not permitted/,
			);
			await assert.rejects(
				() => resolveAndValidateObsidianPath("data.json", [vaultA]),
				/File extension '\.json' is not permitted/,
			);
			await assert.rejects(
				() => resolveAndValidateObsidianPath("doc.txt", [vaultA]),
				/File extension '\.txt' is not permitted/,
			);
			await assert.rejects(
				() => resolveAndValidateObsidianPath("noext", [vaultA]),
				/File extension '' is not permitted/,
			);
		});

		it("rejects forbidden directory segments (.obsidian, .git, node_modules, .Trash)", async () => {
			await assert.rejects(
				() => resolveAndValidateObsidianPath(path.join(vaultA, ".obsidian", "plugins.md"), [vaultA]),
				/Access to protected directory \(\.obsidian, \.git, node_modules, \.Trash\) is forbidden/,
			);
			await assert.rejects(
				() => resolveAndValidateObsidianPath(path.join(vaultA, ".git", "HEAD.md"), [vaultA]),
				/Access to protected directory \(\.obsidian, \.git, node_modules, \.Trash\) is forbidden/,
			);
			await assert.rejects(
				() => resolveAndValidateObsidianPath(path.join(vaultA, "node_modules", "package.md"), [vaultA]),
				/Access to protected directory \(\.obsidian, \.git, node_modules, \.Trash\) is forbidden/,
			);
			await assert.rejects(
				() => resolveAndValidateObsidianPath(path.join(vaultA, ".Trash", "deleted.md"), [vaultA]),
				/Access to protected directory \(\.obsidian, \.git, node_modules, \.Trash\) is forbidden/,
			);
		});

		it("rejects paths outside configured folders", async () => {
			await assert.rejects(
				() => resolveAndValidateObsidianPath(path.join(outsideDir, "escape.md"), [vaultA]),
				/is outside all configured Obsidian folders/,
			);
		});

		it("rejects path traversal attempts", async () => {
			await assert.rejects(
				() => resolveAndValidateObsidianPath(path.join(vaultA, "..", "outside", "escape.md"), [vaultA]),
				/is outside all configured Obsidian folders/,
			);
			await assert.rejects(
				() => resolveAndValidateObsidianPath("../../../etc/passwd.md", [vaultA]),
				/is outside all configured Obsidian folders/,
			);
		});

		it("rejects symlink escape pointing outside configured vault", async () => {
			const symlinkDir = path.join(vaultA, "escape_link");
			try {
				await fs.symlink(outsideDir, symlinkDir, "dir");
			} catch {
				// symlink might already exist
			}
			await assert.rejects(
				() => resolveAndValidateObsidianPath(path.join(symlinkDir, "secret.md"), [vaultA]),
				/outside all configured Obsidian folders/,
			);
		});

		it("rejects symlink escape pointing to forbidden directory", async () => {
			const dotObsidianDir = path.join(tempBase, ".obsidian_real");
			await fs.mkdir(dotObsidianDir, { recursive: true });
			const symlinkObsidian = path.join(vaultA, "obsidian_link");
			try {
				await fs.symlink(dotObsidianDir, symlinkObsidian, "dir");
			} catch {
				// ignore
			}
			// Even if named differently, if target contains .obsidian or resolves outside, it fails
			await assert.rejects(
				() => resolveAndValidateObsidianPath(path.join(symlinkObsidian, "note.md"), [vaultA]),
				/outside all configured Obsidian folders/,
			);
		});
	});

	describe("write tool", () => {
		const write = (folders: readonly string[], input: { path: string; content: string }) =>
			writeTool(folders).execute!("c_write", input).then((r) => {
				assert.ok(r.content.length >= 1);
				const first = r.content[0]!;
				assert.equal(first.type, "text");
				return (first as { type: "text"; text: string }).text;
			});

		it("creates a new markdown file with exact content", async () => {
			const targetPath = path.join(vaultA, "hello.md");
			const content = "# Hello World\n\nThis is a note from the agent.";
			const result = await write([vaultA], { path: targetPath, content });

			assert.match(result, /Successfully wrote \d+ bytes to hello\.md/);
			const readContent = await fs.readFile(targetPath, "utf-8");
			assert.equal(readContent, content);
		});

		it("creates parent directories recursively if needed", async () => {
			const targetPath = path.join(vaultA, "nested", "deep", "dir", "structure.markdown");
			const content = "Nested markdown note.";
			const result = await write([vaultA], { path: targetPath, content });

			assert.match(result, /Successfully wrote \d+ bytes to structure\.markdown/);
			const readContent = await fs.readFile(targetPath, "utf-8");
			assert.equal(readContent, content);
		});

		it("overwrites existing file", async () => {
			const targetPath = path.join(vaultA, "overwrite.md");
			await fs.writeFile(targetPath, "original content", "utf-8");

			const newContent = "updated content";
			await write([vaultA], { path: targetPath, content: newContent });

			const readContent = await fs.readFile(targetPath, "utf-8");
			assert.equal(readContent, newContent);
		});

		it("resolves relative path inside first configured folder", async () => {
			const relPath = "relative-note.mdx";
			const content = "MDX content";
			await write([vaultA, vaultB], { path: relPath, content });

			const readContent = await fs.readFile(path.join(vaultA, relPath), "utf-8");
			assert.equal(readContent, content);
		});

		it("fails when writing non-markdown file", async () => {
			await assert.rejects(
				() => write([vaultA], { path: path.join(vaultA, "script.ts"), content: "console.log(1);" }),
				/File extension '\.ts' is not permitted/,
			);
		});

		it("fails when writing outside configured folders", async () => {
			await assert.rejects(
				() => write([vaultA], { path: path.join(outsideDir, "evil.md"), content: "bad" }),
				/is outside all configured Obsidian folders/,
			);
		});

		it("fails when obsidianFolders is empty", async () => {
			await assert.rejects(
				() => write([], { path: path.join(vaultA, "note.md"), content: "test" }),
				/No Obsidian folders are configured in Settings/,
			);
		});

		it("fails when writing into .obsidian directory", async () => {
			await assert.rejects(
				() => write([vaultA], { path: path.join(vaultA, ".obsidian", "note.md"), content: "bad" }),
				/Access to protected directory \(\.obsidian, \.git, node_modules, \.Trash\) is forbidden/,
			);
		});
	});

	describe("edit tool", () => {
		const edit = (folders: readonly string[], input: { path: string; oldText: string; newText: string; multiple?: boolean }) =>
			editTool(folders).execute!("c_edit", input).then((r) => {
				assert.ok(r.content.length >= 1);
				const first = r.content[0]!;
				assert.equal(first.type, "text");
				return (first as { type: "text"; text: string }).text;
			});

		it("replaces unique text in an existing file", async () => {
			const targetPath = path.join(vaultB, "edit-target.md");
			await fs.writeFile(targetPath, "# Title\n\nOld passage here.\n\nFooter", "utf-8");

			const result = await edit([vaultB], {
				path: targetPath,
				oldText: "Old passage here.",
				newText: "New improved passage here.",
			});

			assert.match(result, /Successfully replaced 1 occurrence\(s\) in edit-target\.md/);
			const readContent = await fs.readFile(targetPath, "utf-8");
			assert.equal(readContent, "# Title\n\nNew improved passage here.\n\nFooter");
		});

		it("replaces multiple occurrences when multiple: true", async () => {
			const targetPath = path.join(vaultB, "multiple-target.md");
			await fs.writeFile(targetPath, "apple banana apple cherry apple", "utf-8");

			const result = await edit([vaultB], {
				path: targetPath,
				oldText: "apple",
				newText: "orange",
				multiple: true,
			});

			assert.match(result, /Successfully replaced 3 occurrence\(s\) in multiple-target\.md/);
			const readContent = await fs.readFile(targetPath, "utf-8");
			assert.equal(readContent, "orange banana orange cherry orange");
		});

		it("fails when oldText matches multiple times without multiple: true", async () => {
			const targetPath = path.join(vaultB, "ambiguous-target.md");
			await fs.writeFile(targetPath, "foo bar foo", "utf-8");

			await assert.rejects(
				() => edit([vaultB], { path: targetPath, oldText: "foo", newText: "baz" }),
				/oldText matches 2 times in ambiguous-target\.md\. Provide more surrounding context to match uniquely, or set multiple: true\./,
			);
		});

		it("fails when oldText is not found in file", async () => {
			const targetPath = path.join(vaultB, "missing-text.md");
			await fs.writeFile(targetPath, "some text", "utf-8");

			await assert.rejects(
				() => edit([vaultB], { path: targetPath, oldText: "nonexistent text", newText: "new" }),
				/oldText not found in missing-text\.md/,
			);
		});

		it("fails when target file does not exist (ENOENT)", async () => {
			await assert.rejects(
				() => edit([vaultB], { path: path.join(vaultB, "does-not-exist.md"), oldText: "old", newText: "new" }),
				/File not found/,
			);
		});

		it("fails when editing non-markdown file", async () => {
			await assert.rejects(
				() => edit([vaultB], { path: path.join(vaultB, "notes.txt"), oldText: "old", newText: "new" }),
				/File extension '\.txt' is not permitted/,
			);
		});

		it("fails when editing outside configured folders", async () => {
			await assert.rejects(
				() => edit([vaultB], { path: path.join(outsideDir, "leak.md"), oldText: "old", newText: "new" }),
				/is outside all configured Obsidian folders/,
			);
		});

		it("fails when obsidianFolders is empty", async () => {
			await assert.rejects(
				() => edit([], { path: path.join(vaultB, "edit-target.md"), oldText: "old", newText: "new" }),
				/No Obsidian folders are configured in Settings/,
			);
		});
	});

	describe("UI activity labels", () => {
		it("provides descriptive activity labels for write and edit", () => {
			assert.equal(toolActivityLabel("write"), "Writing a file…");
			assert.equal(toolActivityLabel("edit"), "Editing a file…");
		});
	});
});
