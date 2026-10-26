import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Shared plumbing for the learner-filesystem tools (ls / find / grep) —
 * sources v1 (2026-09-19): the agent locates and reads the learner's files
 * itself, so paths need no UI affordance (user decision: no attachments —
 * the learner references files in messages; the agent finds them).
 *
 * Safety posture (user-locked): READ-ONLY by construction — no shell-out,
 * no user-controlled process args, no mutation APIs anywhere here. The one
 * deliberate scope widening vs pi: relative paths and default roots resolve
 * against the LEARNER'S HOME, not a project cwd — the harness has no
 * meaningful working directory, and "find my notes" should just work.
 *
 * Ported behaviors (mirroring pi's dist/core/tools/{ls,find,grep}.js): the
 * schemas, descriptions, output formats, and truncation notices are copied
 * verbatim except where semantics differ (home default, no .gitignore —
 * replaced by hard noise exclusions).
 */

/** 50KB — pi's DEFAULT_MAX_BYTES, the output ceiling for every fs tool. */
export const MAX_OUTPUT_BYTES = 50 * 1024;
/** pi's grep line-truncation length (GREP_MAX_LINE_LENGTH). */
export const GREP_MAX_LINE_LENGTH = 500;
/** Wall-clock budget for tree walks (find/grep over a whole home dir). */
export const WALK_TIMEOUT_MS = 10_000;

/**
 * Directory names never entered during walks. node_modules/.git mirror pi's
 * fd/rg defaults; Library/.Trash are the home-root noise the user approved
 * (2026-09-19) — caches, app support, and the trash live under them.
 * Explicit paths (ls/read of ~/Library/…) are NOT filtered — only walks.
 */
const EXCLUDED_DIR_NAMES = new Set(["node_modules", ".git", "Library", ".Trash"]);

/** Resolve a tool path argument: absolute stays, relative/absent → home.
 *  (pi resolves against the project cwd; the harness's "project" is the
 *  learner's life, so the home directory is the anchor.) */
export function resolveSourcePath(p?: string): string {
	if (!p) return os.homedir();
	return path.isAbsolute(p) ? p : path.join(os.homedir(), p);
}

/** pi's formatSize idiom (50KB prints as "50.0KB"). */
export function formatSize(bytes: number): string {
	return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${bytes}B`;
}

/** Cap output to MAX_OUTPUT_BYTES on whole lines, pi's truncateHead idiom. */
export function capOutput(lines: string[]): { content: string; truncated: boolean } {
	const out: string[] = [];
	for (const line of lines) {
		const candidate = [...out, line].join("\n");
		if (Buffer.byteLength(candidate, "utf-8") > MAX_OUTPUT_BYTES) {
			return { content: out.join("\n"), truncated: true };
		}
		out.push(line);
	}
	return { content: out.join("\n"), truncated: false };
}

/** Expand top-level brace alternatives: '*.{ts,tsx}' → ['*.ts', '*.tsx'].
 *  Nested braces are out of scope (pi's fd handles them; models rarely
 *  emit them — a non-expanding literal match is the graceful fallback). */
export function expandBraces(pattern: string): string[] {
	const open = pattern.indexOf("{");
	if (open === -1) return [pattern];
	const close = pattern.indexOf("}", open);
	if (close === -1) return [pattern];
	const before = pattern.slice(0, open);
	const after = pattern.slice(close + 1);
	const alts: string[] = [];
	for (const alt of pattern.slice(open + 1, close).split(",")) {
		alts.push(...expandBraces(before + alt + after));
	}
	return alts;
}

/** Glob → anchored RegExp. '*' stays within a segment, '**' crosses '/',
 *  '?' is one char, everything else literal. */
export function globToRegex(glob: string): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i]!;
		if (c === "*") {
			if (glob[i + 1] === "*") {
				re += "[\\s\\S]*";
				i++;
				if (glob[i + 1] === "/") i++; // '**/' also eats the slash
			} else {
				re += "[^/]*";
			}
		} else if (c === "?") {
			re += "[^/]";
		} else {
			re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`^${re}$`);
}

/**
 * pi/fd's matching rule: a pattern with no slash matches against the
 * BASENAME at any depth; one with a slash matches the relative path, with
 * an implied leading "**-slash" prefix unless it is itself anchored (see
 * the code below — the literal sequence cannot appear in this comment
 * because it terminates block comments).
 */
export function matchGlob(relativePath: string, pattern: string): boolean {
	const posix = relativePath.split(path.sep).join("/");
	const basename = posix.split("/").pop() ?? posix;
	for (const alt of expandBraces(pattern)) {
		if (!alt.includes("/")) {
			if (globToRegex(alt).test(basename)) return true;
		} else {
			let effective = alt;
			if (!effective.startsWith("/") && !effective.startsWith("**/") && effective !== "**") {
				effective = `**/${effective}`;
			}
			if (effective.startsWith("/")) effective = effective.slice(1);
			if (globToRegex(effective).test(posix)) return true;
		}
	}
	return false;
}

/**
 * Depth-first walk under `root`, never entering EXCLUDED_DIR_NAMES.
 * `visit` receives absolute file paths; returning true STOPS the walk
 * (find's result limit). The deadline bounds a home-dir walk to
 * WALK_TIMEOUT_MS — partial results are the graceful degradation.
 */
export async function walkFiles(
	root: string,
	visit: (filePath: string) => boolean | Promise<boolean>,
	signal?: AbortSignal,
): Promise<{ timedOut: boolean; aborted: boolean }> {
	const deadline = Date.now() + WALK_TIMEOUT_MS;
	let timedOut = false;
	let aborted = false;
	if (signal?.aborted) return { timedOut: false, aborted: true };

	const walkDir = async (dir: string): Promise<boolean> => {
		if (Date.now() > deadline) {
			timedOut = true;
			return true; // stop
		}
		if (signal?.aborted) {
			aborted = true;
			return true; // stop — abort yields partial results, not a throw
		}
		let entries: import("node:fs").Dirent[];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return false; // unreadable dir (permissions): skip, keep walking
		}
		for (const entry of entries) {
			if (Date.now() > deadline) {
				timedOut = true;
				return true;
			}
			if (signal?.aborted) {
				aborted = true;
				return true;
			}
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
				if (await walkDir(full)) return true;
			} else if (entry.isFile()) {
				if (await visit(full)) return true;
			}
			// symlinks/other: not followed (pi's fd doesn't follow either)
		}
		return false;
	};

	await walkDir(root);
	return { timedOut, aborted };
}

/** True if the first 8KB chunk contains a NUL byte — pi/rg's binary skip. */
export async function isBinaryFile(filePath: string): Promise<boolean> {
	const handle = await fs.open(filePath, "r");
	try {
		const buf = Buffer.alloc(8192);
		const { bytesRead } = await handle.read(buf, 0, 8192, 0);
		return buf.subarray(0, bytesRead).includes(0);
	} finally {
		await handle.close();
	}
}

/** pi's GREP_MAX_LINE_LENGTH line truncation (no mid-word care, hard cap). */
export function truncateGrepLine(line: string): { text: string; wasTruncated: boolean } {
	if (line.length <= GREP_MAX_LINE_LENGTH) return { text: line, wasTruncated: false };
	return { text: `${line.slice(0, GREP_MAX_LINE_LENGTH)}… [truncated]`, wasTruncated: true };
}

/** Markdown extensions permitted for write/edit tools. */
export const ALLOWED_MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdx"]);

/** Directory segments strictly forbidden for agent mutation. */
export const FORBIDDEN_OBSIDIAN_DIRS = new Set([".obsidian", ".git", "node_modules", ".Trash"]);

function isInsideFolder(parent: string, child: string): boolean {
	const rel = path.relative(parent, child);
	return !rel.startsWith("..") && !path.isAbsolute(rel) && rel !== "";
}

/**
 * Validates and resolves a file path strictly scoped to configured Obsidian folders.
 * Enforces:
 * 1. obsidianFolders must be configured and non-empty.
 * 2. File extension must be .md, .markdown, or .mdx (case-insensitive).
 * 3. Path must not traverse through forbidden directories (.obsidian, .git, node_modules, .Trash).
 * 4. Path must resolve within at least one configured Obsidian folder (preventing traversal and root escapes).
 * 5. Symlinks cannot escape configured folders or enter forbidden directories (checks canonical paths).
 */
export async function resolveAndValidateObsidianPath(
	rawPath: string,
	obsidianFolders?: readonly string[],
): Promise<string> {
	if (!obsidianFolders || obsidianFolders.length === 0) {
		throw new Error("No Obsidian folders are configured in Settings. Please add an Obsidian folder in Settings -> Agent first.");
	}

	if (!rawPath || typeof rawPath !== "string" || !rawPath.trim()) {
		throw new Error("Path must not be empty.");
	}

	const trimmed = rawPath.trim();
	const normalizedRoots = obsidianFolders
		.map((f) => (f.startsWith("~") ? f.replace(/^~(?=$|\/|\\)/, os.homedir()) : f))
		.map((f) => path.resolve(f));

	if (normalizedRoots.length === 0) {
		throw new Error("No Obsidian folders are configured in Settings. Please add an Obsidian folder in Settings -> Agent first.");
	}

	// Extension check (case-insensitive)
	const ext = path.extname(trimmed).toLowerCase();
	if (!ALLOWED_MARKDOWN_EXTENSIONS.has(ext)) {
		throw new Error(`File extension '${ext}' is not permitted. Only Markdown files (.md, .markdown, .mdx) are allowed.`);
	}

	// Resolve target candidate path
	let candidate: string;
	if (trimmed.startsWith("~")) {
		candidate = path.resolve(trimmed.replace(/^~(?=$|\/|\\)/, os.homedir()));
	} else if (path.isAbsolute(trimmed)) {
		candidate = path.resolve(trimmed);
	} else {
		// Relative path: check if it exists in any configured folder; otherwise resolve against first folder
		const potentialPaths = normalizedRoots.map((root) => path.resolve(root, trimmed));
		let selected = potentialPaths[0]!;
		for (const p of potentialPaths) {
			try {
				await fs.stat(p);
				selected = p;
				break;
			} catch {
				// keep looking
			}
		}
		candidate = selected;
	}

	// Check forbidden directory segments on candidate path
	const candidateSegments = candidate.split(/[/\\]/).filter(Boolean);
	if (candidateSegments.some((s) => FORBIDDEN_OBSIDIAN_DIRS.has(s))) {
		throw new Error("Access to protected directory (.obsidian, .git, node_modules, .Trash) is forbidden.");
	}

	// Confinement check: candidate must be inside at least one configured folder
	const insideLogical = normalizedRoots.some((root) => isInsideFolder(root, candidate));
	if (!insideLogical) {
		throw new Error(`Path '${rawPath}' is outside all configured Obsidian folders.`);
	}

	// Canonical folder roots (resolving symlinks if folders exist)
	const canonicalRoots = await Promise.all(
		normalizedRoots.map(async (root) => {
			try {
				return await fs.realpath(root);
			} catch {
				return root;
			}
		}),
	);

	// Symlink escape check:
	// If the file exists, inspect its realpath.
	// If the file does NOT exist (new file for write), inspect the realpath of the deepest existing ancestor directory.
	let existingPathToCheck: string | null = null;
	try {
		await fs.lstat(candidate);
		existingPathToCheck = candidate;
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			let ancestor = path.dirname(candidate);
			while (ancestor !== path.dirname(ancestor)) {
				try {
					await fs.stat(ancestor);
					existingPathToCheck = ancestor;
					break;
				} catch (aErr: unknown) {
					if ((aErr as NodeJS.ErrnoException).code === "ENOENT") {
						ancestor = path.dirname(ancestor);
						continue;
					}
					throw aErr;
				}
			}
		} else {
			throw err;
		}
	}

	if (existingPathToCheck) {
		const realPath = await fs.realpath(existingPathToCheck);
		const realSegments = realPath.split(/[/\\]/).filter(Boolean);
		if (realSegments.some((s) => FORBIDDEN_OBSIDIAN_DIRS.has(s))) {
			throw new Error("Access to protected directory (.obsidian, .git, node_modules, .Trash) is forbidden.");
		}
		const isFile = existingPathToCheck === candidate;
		const insideCanonical = canonicalRoots.some((root) =>
			isFile ? isInsideFolder(root, realPath) : realPath === root || isInsideFolder(root, realPath),
		);
		if (!insideCanonical) {
			throw new Error(`Path '${rawPath}' is outside all configured Obsidian folders.`);
		}
	}

	return candidate;
}

