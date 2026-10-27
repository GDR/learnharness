/**
 * Obsidian Deep-Links, Wiki-Link Resolution, Backlink Indexing & Rename Refactoring.
 *
 * Core pure domain functions for:
 * 1. Generating & parsing obsidian:// URIs with vault, file, heading, and blockId.
 * 2. Multi-tier Obsidian wiki-link resolution (relative folder, root path, basename, case-insensitive).
 * 3. Bidirectional backlink indexing across documents with context snippets.
 * 4. Safe AST-aligned note rename refactoring preserving aliases and subpaths.
 *
 * All functions are browser-safe, pure TypeScript without Node.js runtime dependencies.
 */

import type {
	ObsidianDeepLinkOptions,
	WikiLinkResolution,
	WikiLinkResolutionSubpath,
	BacklinkReference,
	RenameRefactorResult,
	ParsedObsidianDocument,
	ParsedWikiLink,
} from "../contracts/obsidian.ts";

// ─── Pure Path Utilities ─────────────────────────────────────────────────────

export function normalizeNotePath(filePath: string): string {
	return filePath
		.replace(/\\/g, "/")
		.replace(/^\.\//, "")
		.replace(/^\/+|\/+$/g, "")
		.replace(/\.mdx?$/i, "");
}

export function getNoteBasename(filePath: string): string {
	const normalized = normalizeNotePath(filePath);
	const slashIdx = normalized.lastIndexOf("/");
	return slashIdx >= 0 ? normalized.slice(slashIdx + 1) : normalized;
}

export function getNoteDir(filePath: string): string {
	const normalized = normalizeNotePath(filePath);
	const slashIdx = normalized.lastIndexOf("/");
	return slashIdx >= 0 ? normalized.slice(0, slashIdx) : "";
}

export function resolveRelativeNotePath(baseDir: string, relPath: string): string {
	const normRel = relPath.replace(/\\/g, "/");
	const parts = baseDir ? baseDir.split("/").filter(Boolean) : [];
	const relParts = normRel.split("/").filter(Boolean);

	for (const part of relParts) {
		if (part === ".") continue;
		if (part === "..") {
			parts.pop();
		} else {
			parts.push(part);
		}
	}
	return parts.join("/");
}

export function isSamePath(a: string, b: string): boolean {
	return normalizeNotePath(a).toLowerCase() === normalizeNotePath(b).toLowerCase();
}

// ─── 1. Deep-Link Generator ──────────────────────────────────────────────────

export function createObsidianDeepLink(options: ObsidianDeepLinkOptions): string {
	if (!options?.vaultName?.trim()) throw new Error("vaultName must be a non-empty string");
	if (!options?.filePath?.trim()) throw new Error("filePath must be a non-empty string");

	const cleanPath = normalizeNotePath(options.filePath);
	if (!cleanPath) throw new Error("filePath cannot be empty after normalization");

	let uri = `obsidian://open?vault=${encodeURIComponent(options.vaultName.trim())}&file=${encodeURIComponent(cleanPath)}`;

	if (options.blockId?.trim()) {
		const cleanBlockId = options.blockId.trim().replace(/^\^/, "");
		if (cleanBlockId) uri += `#^${encodeURIComponent(cleanBlockId)}`;
	} else if (options.heading?.trim()) {
		const cleanHeading = options.heading.trim().replace(/^#/, "");
		if (cleanHeading) uri += `#${encodeURIComponent(cleanHeading)}`;
	}

	return uri;
}

// ─── 2. Deep-Link Parser ────────────────────────────────────────────────────

export function parseObsidianDeepLink(uri: string): ObsidianDeepLinkOptions | null {
	if (typeof uri !== "string" || !uri.trim().startsWith("obsidian://")) return null;

	try {
		const url = new URL(uri);
		if (url.protocol !== "obsidian:") return null;

		let vaultName = "";
		let filePath = "";
		let rawHash = url.hash ? url.hash.slice(1) : "";
		const host = url.hostname || url.host;

		if (host === "open") {
			vaultName = url.searchParams.get("vault") ?? "";
			filePath = url.searchParams.get("file") ?? "";
		} else if (host === "vault") {
			const pathname = decodeURIComponent(url.pathname).replace(/^\/+/, "");
			const slashIdx = pathname.indexOf("/");
			if (slashIdx === -1) return null;
			vaultName = pathname.slice(0, slashIdx);
			filePath = pathname.slice(slashIdx + 1);
		} else {
			return null;
		}

		if (!vaultName.trim() || !filePath.trim()) return null;

		if (!rawHash && filePath.includes("#")) {
			const hashIdx = filePath.indexOf("#");
			rawHash = filePath.slice(hashIdx + 1);
			filePath = filePath.slice(0, hashIdx);
		}

		let heading: string | undefined;
		let blockId: string | undefined;

		if (rawHash) {
			const decoded = decodeURIComponent(rawHash).trim();
			if (decoded.startsWith("^")) {
				const b = decoded.slice(1).trim();
				if (b) blockId = b;
			} else if (decoded) {
				heading = decoded;
			}
		}

		const cleanFilePath = normalizeNotePath(filePath);
		if (!cleanFilePath) return null;

		return {
			vaultName: vaultName.trim(),
			filePath: cleanFilePath,
			...(heading ? { heading } : {}),
			...(blockId ? { blockId } : {}),
		};
	} catch {
		return null;
	}
}

// ─── 3. Wiki-Link Resolution ────────────────────────────────────────────────

function matchResult(
	target: string,
	matches: string[],
	subpath?: WikiLinkResolutionSubpath,
): WikiLinkResolution | null {
	if (matches.length === 1 && matches[0]) {
		return { target, resolvedPath: matches[0], subpath, status: "resolved" };
	}
	if (matches.length > 1) {
		return { target, subpath, status: "ambiguous", candidates: matches };
	}
	return null;
}

export function resolveWikiLink(
	target: string,
	availablePaths: string[],
	currentFilePath?: string,
): WikiLinkResolution {
	if (typeof target !== "string") return { target: "", status: "unresolved" };

	let cleanTarget = target.trim();
	if (cleanTarget.startsWith("[[") && cleanTarget.endsWith("]]")) {
		cleanTarget = cleanTarget.slice(2, -2).trim();
	}
	const pipeIdx = cleanTarget.indexOf("|");
	if (pipeIdx >= 0) cleanTarget = cleanTarget.slice(0, pipeIdx).trim();

	let subpath: WikiLinkResolutionSubpath | undefined;
	let noteIdentifier = cleanTarget;
	const hashIdx = cleanTarget.indexOf("#");
	if (hashIdx >= 0) {
		noteIdentifier = cleanTarget.slice(0, hashIdx).trim();
		const rawSub = cleanTarget.slice(hashIdx + 1).trim();
		if (rawSub.startsWith("^")) {
			const bVal = rawSub.slice(1).trim();
			if (bVal) subpath = { type: "block", value: bVal };
		} else if (rawSub) {
			subpath = { type: "heading", value: rawSub };
		}
	}

	if (!noteIdentifier) {
		if (currentFilePath?.trim()) {
			return { target, resolvedPath: currentFilePath, subpath, status: "resolved" };
		}
		return { target, subpath, status: "unresolved" };
	}

	if (!Array.isArray(availablePaths) || availablePaths.length === 0) {
		return { target, subpath, status: "unresolved" };
	}

	const targetNorm = normalizeNotePath(noteIdentifier);
	const targetBase = getNoteBasename(noteIdentifier);
	const isPath = noteIdentifier.includes("/") || noteIdentifier.includes("\\");

	// Tier A: Same directory / relative path from currentFilePath
	if (currentFilePath?.trim()) {
		const currentDir = getNoteDir(currentFilePath);
		if (noteIdentifier.startsWith("./") || noteIdentifier.startsWith("../")) {
			const resolvedRel = resolveRelativeNotePath(currentDir, noteIdentifier);
			const relMatches = availablePaths.filter((p) => normalizeNotePath(p) === resolvedRel);
			const r = matchResult(target, relMatches, subpath);
			if (r) return r;
		} else if (!isPath) {
			const sameFolderNorm = currentDir ? `${currentDir}/${targetBase}` : targetBase;
			const sameFolderMatches = availablePaths.filter((p) => normalizeNotePath(p) === sameFolderNorm);
			const r = matchResult(target, sameFolderMatches, subpath);
			if (r) return r;
		}
	}

	// Tier B: Root-relative exact path
	const exactMatches = availablePaths.filter((p) => normalizeNotePath(p) === targetNorm);
	const rExact = matchResult(target, exactMatches, subpath);
	if (rExact) return rExact;

	// Tier C: Bare basename match (case-sensitive)
	if (!isPath) {
		const basenameMatches = availablePaths.filter((p) => getNoteBasename(p) === targetBase);
		const rBase = matchResult(target, basenameMatches, subpath);
		if (rBase) return rBase;
	}

	// Tier D: Case-insensitive match (path then basename)
	const ciPathMatches = availablePaths.filter(
		(p) => normalizeNotePath(p).toLowerCase() === targetNorm.toLowerCase(),
	);
	const rCiPath = matchResult(target, ciPathMatches, subpath);
	if (rCiPath) return rCiPath;

	const ciBaseMatches = availablePaths.filter(
		(p) => getNoteBasename(p).toLowerCase() === targetBase.toLowerCase(),
	);
	const rCiBase = matchResult(target, ciBaseMatches, subpath);
	if (rCiBase) return rCiBase;

	return { target, subpath, status: "unresolved" };
}

// ─── 4. Backlink Indexing ───────────────────────────────────────────────────

export function buildBacklinkIndex(
	documents: Array<{
		filePath: string;
		parsed: ParsedObsidianDocument;
		rawContent?: string;
	}>,
): Map<string, BacklinkReference[]> {
	const index = new Map<string, BacklinkReference[]>();
	if (!Array.isArray(documents) || documents.length === 0) return index;

	const allPaths = documents.map((doc) => doc.filePath).filter(Boolean);

	for (const doc of documents) {
		const sourceFilePath = doc.filePath || doc.parsed?.filePath || "";
		if (!sourceFilePath) continue;

		let wikiLinks: ParsedWikiLink[] = doc.parsed?.wikiLinks ?? [];
		if (wikiLinks.length === 0 && doc.rawContent?.includes("[[")) {
			wikiLinks = extractWikiLinksFromText(doc.rawContent);
		}

		for (const link of wikiLinks) {
			if (!link.target && !link.subpath) continue;
			const linkTarget =
				link.target ||
				(link.subpath
					? link.subpath.kind === "block"
						? `#^${link.subpath.value}`
						: `#${link.subpath.value}`
					: "");

			const resolution = resolveWikiLink(linkTarget, allPaths, sourceFilePath);
			if (resolution.status === "resolved" && resolution.resolvedPath) {
				const targetPath = resolution.resolvedPath;

				let wikiLinkText = "";
				if (doc.rawContent && link.range && link.range.startOffset < link.range.endOffset) {
					const slice = doc.rawContent.slice(link.range.startOffset, link.range.endOffset);
					if (slice.startsWith("[[") && slice.endsWith("]]")) wikiLinkText = slice;
				}

				if (!wikiLinkText) {
					const subStr = link.subpath
						? link.subpath.kind === "block"
							? `#^${link.subpath.value}`
							: `#${link.subpath.value}`
						: "";
					const aliasStr = link.alias ? `|${link.alias}` : "";
					wikiLinkText = `[[${link.target}${subStr}${aliasStr}]]`;
				}

				let contextSnippet = "";
				if (doc.rawContent && link.range) {
					const content = doc.rawContent;
					const start = link.range.startOffset;
					const end = link.range.endOffset;
					const lineStart = Math.max(0, content.lastIndexOf("\n", start) + 1);
					let lineEnd = content.indexOf("\n", end);
					if (lineEnd === -1) lineEnd = content.length;
					const rawLine = content.slice(lineStart, lineEnd).trim();

					if (rawLine.length > 500) {
						const snippetStart = Math.max(0, start - 100);
						const snippetEnd = Math.min(content.length, end + 100);
						const prefix = snippetStart > 0 ? "..." : "";
						const suffix = snippetEnd < content.length ? "..." : "";
						contextSnippet = prefix + content.slice(snippetStart, snippetEnd).trim() + suffix;
					} else {
						contextSnippet = rawLine;
					}
				} else if (doc.parsed?.blocks && link.range) {
					const block = doc.parsed.blocks.find(
						(b) => b.range.startOffset <= link.range.startOffset && b.range.endOffset >= link.range.endOffset,
					);
					if (block) contextSnippet = block.rawText.trim();
				}

				if (!contextSnippet) contextSnippet = wikiLinkText;

				const subpathStr = link.subpath
					? link.subpath.kind === "block"
						? `^${link.subpath.value}`
						: link.subpath.value
					: undefined;

				const backlink: BacklinkReference = {
					sourceFilePath,
					targetPath,
					wikiLinkText,
					alias: link.alias,
					subpath: subpathStr,
					range: link.range,
					contextSnippet,
				};

				const existing = index.get(targetPath);
				if (existing) {
					existing.push(backlink);
				} else {
					index.set(targetPath, [backlink]);
				}
			}
		}
	}

	return index;
}

// ─── 5. Rename Refactoring ──────────────────────────────────────────────────

export function computeRenameRefactor(options: {
	oldPath: string;
	newPath: string;
	documents: Array<{
		filePath: string;
		content: string;
		parsed: ParsedObsidianDocument;
	}>;
}): RenameRefactorResult[] {
	const { oldPath, newPath, documents } = options;
	const results: RenameRefactorResult[] = [];
	if (!oldPath || !newPath || !Array.isArray(documents) || documents.length === 0) return results;

	const oldNorm = normalizeNotePath(oldPath);
	const newNorm = normalizeNotePath(newPath);
	if (oldNorm === newNorm) return results;

	const allPaths = documents.map((d) => d.filePath).filter(Boolean);
	if (!allPaths.some((p) => normalizeNotePath(p) === oldNorm)) allPaths.push(oldPath);

	const newBase = getNoteBasename(newPath);
	const pathsAfterRename = allPaths.map((p) => (normalizeNotePath(p) === oldNorm ? newPath : p));

	for (const doc of documents) {
		let wikiLinks = doc.parsed?.wikiLinks ?? [];
		if (wikiLinks.length === 0 && doc.content.includes("[[")) {
			wikiLinks = extractWikiLinksFromText(doc.content);
		}
		if (wikiLinks.length === 0) continue;

		let updatedContent = doc.content;
		let replacementsCount = 0;

		const sortedLinks = [...wikiLinks].sort((a, b) => b.range.startOffset - a.range.startOffset);

		for (const link of sortedLinks) {
			if (!link.target) continue;

			const resolution = resolveWikiLink(link.target, allPaths, doc.filePath);
			if (resolution.status === "resolved" && resolution.resolvedPath && isSamePath(resolution.resolvedPath, oldPath)) {
				const hadExtension = /\.mdx?$/i.test(link.target);
				const hadSlash = link.target.includes("/") || link.target.includes("\\");

				let newTarget = "";
				if (hadSlash) {
					newTarget = hadExtension ? `${newNorm}.md` : newNorm;
				} else {
					const checkRes = resolveWikiLink(newBase, pathsAfterRename, doc.filePath);
					if (checkRes.status === "resolved" && checkRes.resolvedPath && isSamePath(checkRes.resolvedPath, newPath)) {
						newTarget = hadExtension ? `${newBase}.md` : newBase;
					} else {
						newTarget = hadExtension ? `${newNorm}.md` : newNorm;
					}
				}

				const start = link.range.startOffset;
				const end = link.range.endOffset;
				if (start >= 0 && end <= updatedContent.length && start < end) {
					const rawSlice = updatedContent.slice(start, end);
					const match = rawSlice.match(/^\[\[([^#|\]]+)(.*)\]\]$/);
					if (match) {
						const subAndAlias = match[2];
						updatedContent = updatedContent.slice(0, start) + `[[${newTarget}${subAndAlias}]]` + updatedContent.slice(end);
						replacementsCount++;
					}
				}
			}
		}

		if (replacementsCount > 0) {
			results.push({
				filePath: doc.filePath,
				originalContent: doc.content,
				updatedContent,
				replacementsCount,
			});
		}
	}

	return results;
}

// ─── Helper Regex Extractor ──────────────────────────────────────────────────

function extractWikiLinksFromText(text: string): ParsedWikiLink[] {
	const links: ParsedWikiLink[] = [];
	const wikilinkRegex = /\[\[([^\]|#\^]+)?(?:#(\^)?([^\]|]+))?(?:\|([^\]]+))?\]\]/g;
	let match: RegExpExecArray | null;
	while ((match = wikilinkRegex.exec(text)) !== null) {
		const startOffset = match.index;
		const endOffset = startOffset + match[0].length;
		const target = (match[1] ?? "").trim();
		const isBlock = Boolean(match[2]);
		const subpathVal = match[3]?.trim();
		const alias = match[4]?.trim();

		links.push({
			target,
			subpath: subpathVal
				? { kind: isBlock ? "block" : "heading", value: subpathVal }
				: undefined,
			alias: alias && alias.length > 0 ? alias : undefined,
			range: { startOffset, endOffset },
		});
	}
	return links;
}
