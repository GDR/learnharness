/**
 * LearnHarness E2E Test Suite Harness & Testing Infrastructure Helper
 *
 * Provides in-process project workspace isolation, fixture vault sandboxing,
 * pure Obsidian Markdown parsing utilities, glob matching, deep-link URI generation,
 * document inventory tracking, and graph evidence ledger assertions.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import * as assert from "node:assert/strict";

// ============================================================================
// Domain Contracts & Types (mirrors PROJECT.md §1 & ORIGINAL_REQUEST.md)
// ============================================================================

export type ProjectId = string;
export type VaultId = string;
export type SourceId = string;
export type DocumentId = string;
export type EvidenceId = string;

export interface ProjectSettings {
  defaultStudyScope: "all" | "manual";
  sourceGrounding: "strict" | "assisted";
}

export interface Project {
  id: ProjectId;
  name: string;
  description?: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
  settings: ProjectSettings;
}

export interface VaultBinding {
  deviceId: string;
  rootPath: string;
  status: "available" | "unavailable";
}

export interface Vault {
  id: VaultId;
  displayName: string;
  kind: "obsidian";
  bindings: VaultBinding[];
}

export interface ProjectSource {
  id: SourceId;
  projectId: ProjectId;
  vaultId: VaultId;
  include: string[];
  exclude: string[];
  recursive: boolean;
  enabled: boolean;
  syncMode: "manual" | "automatic";
  deletionPolicy: "deactivate" | "retain";
  createdAt: string;
}

export interface SourceDocument {
  id: DocumentId;
  sourceId: SourceId;
  vaultId: VaultId;
  currentPath: string;
  contentHash: string;
  revisionId: string;
  status: "active" | "missing" | "excluded" | "error";
  indexedAt?: string;
}

export interface SourceEvidence {
  id: EvidenceId;
  projectId: ProjectId;
  sourceId: SourceId;
  documentId: DocumentId;
  revisionId: string;
  propositionId: string;
  location: {
    heading?: string;
    blockId?: string;
    startOffset?: number;
    endOffset?: number;
  };
  provenance: "explicit-source" | "model-inferred";
  status: "active" | "superseded";
  extractorVersion: string;
}

export interface StudyScope {
  projectId: ProjectId;
  sourceIds?: SourceId[];
  documentIds?: DocumentId[];
  propositionIds?: string[];
  includePrerequisites: boolean;
  grounding: "sources-only" | "sources-plus-external";
}

export interface ObsidianWikilink {
  target: string;
  alias?: string;
  offset: number;
}

export interface ObsidianSection {
  heading?: string;
  level: number;
  content: string;
  startOffset: number;
  endOffset: number;
  blockIds: string[];
  wikilinks: ObsidianWikilink[];
  tags: string[];
}

export interface ObsidianParsedDocument {
  frontmatter: Record<string, unknown>;
  sections: ObsidianSection[];
  wikilinks: ObsidianWikilink[];
  tags: string[];
  blockIds: Record<string, { startOffset: number; endOffset: number }>;
  equations: Array<{ type: "inline" | "block"; content: string; offset: number }>;
  callouts: Array<{ type: string; title: string; content: string; offset: number }>;
  tables: Array<{ header: string[]; rows: string[][]; offset: number }>;
}

// ============================================================================
// Default Exclusions
// ============================================================================

export const DEFAULT_EXCLUDES = [
  ".obsidian/**",
  ".trash/**",
  ".git/**",
  "node_modules/**",
] as const;

// ============================================================================
// Pure Utility: Glob Rule Matching Engine
// ============================================================================

/**
 * Converts a glob pattern string (e.g. `**\/*.md`, `Physics\/**`, `*.json`)
 * into a standard regular expression.
 */
export function globToRegex(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/").trim();
  let regexStr = "^";
  let i = 0;
  const len = normalized.length;

  while (i < len) {
    const c = normalized[i];
    if (!c) {
      i++;
      continue;
    }
    if (c === "*") {
      if (normalized[i + 1] === "*") {
        if (normalized[i + 2] === "/") {
          regexStr += "(?:.*/)?";
          i += 3;
          continue;
        } else {
          regexStr += ".*";
          i += 2;
          continue;
        }
      } else {
        regexStr += "[^/]*";
        i++;
        continue;
      }
    } else if (c === "?") {
      regexStr += "[^/]";
      i++;
    } else if ("[].+^${}()|\\".includes(c)) {
      regexStr += "\\" + c;
      i++;
    } else {
      regexStr += c;
      i++;
    }
  }
  regexStr += "$";
  return new RegExp(regexStr);
}

/**
 * Checks whether a normalized relative file path matches the given include and exclude globs.
 */
export function matchesGlob(
  filePath: string,
  include: string[] = ["**/*.md"],
  exclude: string[] = [...DEFAULT_EXCLUDES]
): boolean {
  const normalizedPath = filePath.replace(/\\/g, "/").replace(/^\.\//, "");

  // Check exclude rules first
  for (const pattern of exclude) {
    const rx = globToRegex(pattern);
    if (rx.test(normalizedPath)) {
      return false;
    }
    // Also check if any parent path matches the exclude pattern (e.g. .obsidian/ or .trash/)
    const parts = normalizedPath.split("/");
    let cumulative = "";
    for (let p = 0; p < parts.length - 1; p++) {
      const part = parts[p];
      if (!part) continue;
      cumulative += (p > 0 ? "/" : "") + part;
      if (globToRegex(pattern).test(cumulative) || globToRegex(pattern).test(cumulative + "/any")) {
        return false;
      }
    }
  }

  // If include is empty, default match is false
  if (!include || include.length === 0) {
    return false;
  }

  // Check include rules
  for (const pattern of include) {
    const rx = globToRegex(pattern);
    if (rx.test(normalizedPath)) {
      return true;
    }
  }

  return false;
}

// ============================================================================
// Pure Utility: Obsidian Deep-Link Generator
// ============================================================================

/**
 * Generates an RFC-compliant `obsidian://open` URI with URI-encoded parameters,
 * supporting target vault, relative file path, heading anchors, and block references.
 */
export function createObsidianDeepLink(
  vaultName: string,
  filePath: string,
  headingOrBlock?: string
): string {
  const cleanVault = vaultName.trim();
  const cleanPath = filePath.replace(/\\/g, "/").replace(/^\.\//, "").trim();

  let fileParam = cleanPath;
  let fragmentSuffix = "";

  if (headingOrBlock) {
    const trimmedAnchor = headingOrBlock.trim();
    if (trimmedAnchor.startsWith("^")) {
      // Block reference anchor
      fragmentSuffix = `#^${encodeURIComponent(trimmedAnchor.slice(1))}`;
    } else if (trimmedAnchor.includes("#^")) {
      const [h, b] = trimmedAnchor.split("#^");
      if (h) fileParam = `${cleanPath}#${h}`;
      if (b) fragmentSuffix = `#^${encodeURIComponent(b)}`;
    } else {
      // Heading anchor
      fileParam = `${cleanPath}#${trimmedAnchor}`;
    }
  }

  const base = `obsidian://open?vault=${encodeURIComponent(cleanVault)}&file=${encodeURIComponent(fileParam)}`;
  return fragmentSuffix ? `${base}${fragmentSuffix}` : base;
}

// ============================================================================
// Pure Utility: Content Hashing
// ============================================================================

/**
 * Computes a deterministic SHA-256 hex digest for document contents.
 */
export function computeDocumentHash(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

// ============================================================================
// Pure Utility: Obsidian Markdown AST Parser
// ============================================================================

/**
 * Parses raw Obsidian Markdown text extracting YAML frontmatter, headings,
 * inline/block LaTeX equations, callouts, block references, wikilinks, tags, and tables
 * while strictly preserving original byte/character offsets.
 */
export function parseObsidianMarkdown(markdown: string): ObsidianParsedDocument {
  const result: ObsidianParsedDocument = {
    frontmatter: {},
    sections: [],
    wikilinks: [],
    tags: [],
    blockIds: {},
    equations: [],
    callouts: [],
    tables: [],
  };

  let body = markdown;
  let bodyOffset = 0;

  // 1. Extract YAML Frontmatter
  const fmMatch = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (fmMatch && fmMatch[1]) {
    const rawFm = fmMatch[1];
    bodyOffset = fmMatch[0].length;
    body = markdown.slice(bodyOffset);

    // Simple YAML parser for key-value, lists, and numbers
    const lines = rawFm.split(/\r?\n/);
    let currentKey: string | null = null;
    let currentList: string[] | null = null;

    for (const line of lines) {
      const listMatch = line.match(/^\s*-\s+(.*)$/);
      const kvMatch = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);

      if (kvMatch && kvMatch[1]) {
        if (currentKey && currentList) {
          result.frontmatter[currentKey] = currentList;
          currentList = null;
        }
        const key = kvMatch[1].trim();
        const rawVal = kvMatch[2] ? kvMatch[2].trim() : "";
        if (rawVal === "") {
          currentKey = key;
          currentList = [];
        } else {
          currentKey = null;
          if (rawVal.toLowerCase() === "true") result.frontmatter[key] = true;
          else if (rawVal.toLowerCase() === "false") result.frontmatter[key] = false;
          else if (!Number.isNaN(Number(rawVal)) && rawVal !== "") result.frontmatter[key] = Number(rawVal);
          else result.frontmatter[key] = rawVal.replace(/^["']|["']$/g, "");
        }
      } else if (listMatch && listMatch[1] && currentKey && currentList) {
        currentList.push(listMatch[1].trim().replace(/^["']|["']$/g, ""));
      }
    }
    if (currentKey && currentList) {
      result.frontmatter[currentKey] = currentList;
    }
  }

  // 2. Extract Block IDs: ^([a-zA-Z0-9_-]+)
  const blockRefRegex = /(?:^|\s)\^([a-zA-Z0-9_-]+)(?=\s|$)/gm;
  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = blockRefRegex.exec(markdown)) !== null) {
    const id = blockMatch[1];
    if (!id) continue;
    const start = blockMatch.index;
    result.blockIds[id] = {
      startOffset: start,
      endOffset: start + blockMatch[0].length,
    };
  }

  // 3. Extract Wikilinks: [[target|alias]] or [[target]]
  const wikilinkRegex = /\[\[([^|\]\r\n]+)(?:\|([^\]\r\n]+))?\]\]/g;
  let wlMatch: RegExpExecArray | null;
  while ((wlMatch = wikilinkRegex.exec(markdown)) !== null) {
    const target = wlMatch[1];
    if (!target) continue;
    result.wikilinks.push({
      target: target.trim(),
      alias: wlMatch[2] ? wlMatch[2].trim() : undefined,
      offset: wlMatch.index,
    });
  }

  // 4. Extract Tags: #tag-name
  const tagRegex = /(?:^|\s)#([a-zA-Z][a-zA-Z0-9_/-]*)(?=\s|$)/g;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = tagRegex.exec(markdown)) !== null) {
    const tag = tagMatch[1];
    if (tag && !result.tags.includes(tag)) {
      result.tags.push(tag);
    }
  }

  // 5. Extract Equations (Block $$...$$ and Inline $...$)
  const blockEqRegex = /\$\$([\s\S]*?)\$\$/g;
  let eqMatch: RegExpExecArray | null;
  while ((eqMatch = blockEqRegex.exec(markdown)) !== null) {
    const content = eqMatch[1];
    if (content !== undefined) {
      result.equations.push({
        type: "block",
        content: content.trim(),
        offset: eqMatch.index,
      });
    }
  }

  const inlineEqRegex = /(?<!\$)\$(?!\$)([^\$\n]+?)(?<!\$)\$(?!\$)/g;
  while ((eqMatch = inlineEqRegex.exec(markdown)) !== null) {
    const content = eqMatch[1];
    if (content !== undefined) {
      result.equations.push({
        type: "inline",
        content: content.trim(),
        offset: eqMatch.index,
      });
    }
  }

  // 6. Extract Callouts: > [!type] Title
  const calloutRegex = /^>\s*\[!([a-zA-Z0-9_-]+)\]\s*(.*?)(?:\r?\n((?:>.*(?:\r?\n|$))*)|$)/gm;
  let coMatch: RegExpExecArray | null;
  while ((coMatch = calloutRegex.exec(markdown)) !== null) {
    const type = coMatch[1];
    if (!type) continue;
    result.callouts.push({
      type: type.toLowerCase(),
      title: coMatch[2] ? coMatch[2].trim() : "",
      content: coMatch[3] ? coMatch[3].replace(/^>\s?/gm, "").trim() : "",
      offset: coMatch.index,
    });
  }

  // 7. Extract Tables
  const tableRegex = /^\|([^\r\n]+)\|\r?\n\|([:\-\s|]+)\|\r?\n((?:\|[^\r\n]*\|\r?\n?)+)/gm;
  let tblMatch: RegExpExecArray | null;
  while ((tblMatch = tableRegex.exec(markdown)) !== null) {
    const rawHeader = tblMatch[1];
    const rawBody = tblMatch[3];
    if (!rawHeader || !rawBody) continue;
    const header = rawHeader.split("|").map((col) => col.trim());
    const rawRows = rawBody.trim().split(/\r?\n/);
    const rows = rawRows
      .filter((r) => r.trim().length > 0)
      .map((r) => r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
    result.tables.push({
      header,
      rows,
      offset: tblMatch.index,
    });
  }

  // 8. Extract Hierarchical Sections
  const headingRegex = /^(#{1,6})\s+(.+)$/gm;
  const headings: Array<{ level: number; heading: string; offset: number }> = [];
  let hMatch: RegExpExecArray | null;
  while ((hMatch = headingRegex.exec(markdown)) !== null) {
    const marks = hMatch[1];
    const text = hMatch[2];
    if (!marks || !text) continue;
    headings.push({
      level: marks.length,
      heading: text.trim(),
      offset: hMatch.index,
    });
  }

  const firstHeading = headings[0];
  if (!firstHeading) {
    // Single root section
    result.sections.push({
      level: 0,
      content: markdown,
      startOffset: 0,
      endOffset: markdown.length,
      blockIds: Object.keys(result.blockIds),
      wikilinks: result.wikilinks,
      tags: result.tags,
    });
  } else {
    // Lead section before first heading
    if (firstHeading.offset > 0) {
      const leadContent = markdown.slice(0, firstHeading.offset);
      result.sections.push({
        level: 0,
        content: leadContent,
        startOffset: 0,
        endOffset: firstHeading.offset,
        blockIds: Object.keys(result.blockIds).filter(
          (k) => (result.blockIds[k]?.startOffset ?? 0) < firstHeading.offset
        ),
        wikilinks: result.wikilinks.filter((wl) => wl.offset < firstHeading.offset),
        tags: result.tags.filter((t) => leadContent.includes(`#${t}`)),
      });
    }

    for (let i = 0; i < headings.length; i++) {
      const cur = headings[i];
      if (!cur) continue;
      const nextHeading = i + 1 < headings.length ? headings[i + 1] : undefined;
      const nextOffset = nextHeading ? nextHeading.offset : markdown.length;
      const secContent = markdown.slice(cur.offset, nextOffset);

      result.sections.push({
        heading: cur.heading,
        level: cur.level,
        content: secContent,
        startOffset: cur.offset,
        endOffset: nextOffset,
        blockIds: Object.keys(result.blockIds).filter(
          (k) => {
            const span = result.blockIds[k];
            return span ? span.startOffset >= cur.offset && span.startOffset < nextOffset : false;
          }
        ),
        wikilinks: result.wikilinks.filter(
          (wl) => wl.offset >= cur.offset && wl.offset < nextOffset
        ),
        tags: result.tags.filter((t) => secContent.includes(`#${t}`)),
      });
    }
  }

  return result;
}

// ============================================================================
// Test Harness Core Environment
// ============================================================================

export interface TestHarnessOptions {
  storageDir?: string;
  goldenVaultDir?: string;
}

export class TestHarness {
  readonly rootDir: string;
  readonly globalDataDir: string;
  readonly projectsDataDir: string;
  readonly goldenVaultDir: string;
  private readonly createdTempDirs: string[] = [];

  constructor(options: TestHarnessOptions = {}) {
    this.rootDir =
      options.storageDir ||
      fs.mkdtempSync(path.join(os.tmpdir(), "lh-test-harness-storage-"));
    this.createdTempDirs.push(this.rootDir);

    this.globalDataDir = path.join(this.rootDir, "data", "global");
    this.projectsDataDir = path.join(this.rootDir, "data", "projects");

    fs.mkdirSync(this.globalDataDir, { recursive: true });
    fs.mkdirSync(this.projectsDataDir, { recursive: true });

    this.goldenVaultDir =
      options.goldenVaultDir ||
      path.resolve(process.cwd(), "tests/fixtures/obsidian-vault");
  }

  /**
   * Cleans up all temporary directories allocated during test execution.
   */
  cleanup(): void {
    for (const dir of this.createdTempDirs) {
      if (fs.existsSync(dir)) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          // ignore cleanup race conditions in temp
        }
      }
    }
    this.createdTempDirs.length = 0;
  }

  /**
   * Creates an isolated, mutable sandbox copy of the golden fixture Obsidian vault.
   * Modifying notes in this sandbox never pollutes git fixtures.
   */
  createSandboxVault(): { vaultPath: string; cleanup: () => void } {
    const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-vault-sandbox-"));
    this.createdTempDirs.push(sandboxDir);

    if (fs.existsSync(this.goldenVaultDir)) {
      copyDirectoryRecursive(this.goldenVaultDir, sandboxDir);
    }

    return {
      vaultPath: sandboxDir,
      cleanup: () => {
        if (fs.existsSync(sandboxDir)) {
          fs.rmSync(sandboxDir, { recursive: true, force: true });
        }
      },
    };
  }

  // --------------------------------------------------------------------------
  // Project Storage Operations
  // --------------------------------------------------------------------------

  async createProject(input: {
    name: string;
    description?: string;
    settings?: Partial<ProjectSettings>;
  }): Promise<Project> {
    if (!input.name || input.name.trim().length === 0) {
      throw new Error("Project name is required");
    }

    const id = `proj_${crypto.randomBytes(6).toString("hex")}`;
    const now = new Date().toISOString();
    const project: Project = {
      id,
      name: input.name.trim(),
      description: input.description,
      status: "active",
      createdAt: now,
      updatedAt: now,
      settings: {
        defaultStudyScope: input.settings?.defaultStudyScope || "all",
        sourceGrounding: input.settings?.sourceGrounding || "strict",
      },
    };

    // Update global projects registry
    const globalProjectsFile = path.join(this.globalDataDir, "projects.json");
    let projects: Project[] = [];
    if (fs.existsSync(globalProjectsFile)) {
      projects = JSON.parse(fs.readFileSync(globalProjectsFile, "utf-8"));
    }
    projects.push(project);
    fs.writeFileSync(globalProjectsFile, JSON.stringify(projects, null, 2));

    // Initialize per-project directory structure
    const projDir = path.join(this.projectsDataDir, id);
    fs.mkdirSync(path.join(projDir, "chats"), { recursive: true });
    fs.mkdirSync(path.join(projDir, "graph"), { recursive: true });
    fs.mkdirSync(path.join(projDir, "jobs"), { recursive: true });
    fs.mkdirSync(path.join(projDir, "practice"), { recursive: true });
    fs.mkdirSync(path.join(projDir, "sources"), { recursive: true });
    fs.mkdirSync(path.join(projDir, "index"), { recursive: true });

    fs.writeFileSync(
      path.join(projDir, "project.json"),
      JSON.stringify(project, null, 2)
    );

    return project;
  }

  async getProject(id: ProjectId): Promise<Project | null> {
    const projFile = path.join(this.projectsDataDir, id, "project.json");
    if (!fs.existsSync(projFile)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(projFile, "utf-8"));
  }

  // --------------------------------------------------------------------------
  // Vault Storage Operations
  // --------------------------------------------------------------------------

  async registerVault(input: {
    displayName: string;
    rootPath: string;
    deviceId?: string;
    status?: "available" | "unavailable";
  }): Promise<Vault> {
    const id = `vault_${crypto.randomBytes(6).toString("hex")}`;
    const deviceId = input.deviceId || "test-host-local";
    const status = input.status || (fs.existsSync(input.rootPath) ? "available" : "unavailable");

    const vault: Vault = {
      id,
      displayName: input.displayName,
      kind: "obsidian",
      bindings: [
        {
          deviceId,
          rootPath: input.rootPath,
          status,
        },
      ],
    };

    const vaultsFile = path.join(this.globalDataDir, "vaults.json");
    let vaults: Vault[] = [];
    if (fs.existsSync(vaultsFile)) {
      vaults = JSON.parse(fs.readFileSync(vaultsFile, "utf-8"));
    }
    vaults.push(vault);
    fs.writeFileSync(vaultsFile, JSON.stringify(vaults, null, 2));

    return vault;
  }

  // --------------------------------------------------------------------------
  // Project Source Operations
  // --------------------------------------------------------------------------

  async attachSource(input: {
    projectId: ProjectId;
    vaultId: VaultId;
    include?: string[];
    exclude?: string[];
    recursive?: boolean;
    syncMode?: "manual" | "automatic";
    deletionPolicy?: "deactivate" | "retain";
  }): Promise<ProjectSource> {
    const source: ProjectSource = {
      id: `src_${crypto.randomBytes(6).toString("hex")}`,
      projectId: input.projectId,
      vaultId: input.vaultId,
      include: input.include || ["**/*.md"],
      exclude: input.exclude || [...DEFAULT_EXCLUDES],
      recursive: input.recursive !== undefined ? input.recursive : true,
      enabled: true,
      syncMode: input.syncMode || "manual",
      deletionPolicy: input.deletionPolicy || "deactivate",
      createdAt: new Date().toISOString(),
    };

    const sourcesFile = path.join(
      this.projectsDataDir,
      input.projectId,
      "sources",
      "sources.json"
    );
    let sources: ProjectSource[] = [];
    if (fs.existsSync(sourcesFile)) {
      sources = JSON.parse(fs.readFileSync(sourcesFile, "utf-8"));
    }
    sources.push(source);
    fs.writeFileSync(sourcesFile, JSON.stringify(sources, null, 2));

    return source;
  }

  /**
   * Scans a vault path against source filters, collecting document inventory records.
   */
  async scanSource(
    source: ProjectSource,
    vaultRootPath: string
  ): Promise<{
    documents: SourceDocument[];
    scanSummary: { totalScanned: number; matched: number; excluded: number };
  }> {
    const docs: SourceDocument[] = [];
    let totalScanned = 0;
    let excluded = 0;

    const walk = (currentDir: string) => {
      if (!fs.existsSync(currentDir)) return;
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        const relPath = path.relative(vaultRootPath, fullPath).replace(/\\/g, "/");

        if (entry.isDirectory()) {
          // Check if entire directory is excluded (e.g. .obsidian, .trash)
          const dirCheck = matchesGlob(relPath + "/dummy.md", ["**/*"], source.exclude);
          if (!dirCheck && (relPath.startsWith(".") || source.exclude.some((e) => e.startsWith(relPath)))) {
            excluded++;
            continue;
          }
          if (source.recursive) {
            walk(fullPath);
          }
        } else if (entry.isFile()) {
          totalScanned++;
          if (matchesGlob(relPath, source.include, source.exclude)) {
            const content = fs.readFileSync(fullPath);
            const contentHash = computeDocumentHash(content);
            const docId = `doc_${crypto.createHash("md5").update(relPath).digest("hex").slice(0, 12)}`;
            docs.push({
              id: docId,
              sourceId: source.id,
              vaultId: source.vaultId,
              currentPath: relPath,
              contentHash,
              revisionId: `rev_${contentHash.slice(0, 8)}`,
              status: "active",
              indexedAt: new Date().toISOString(),
            });
          } else {
            excluded++;
          }
        }
      }
    };

    walk(vaultRootPath);

    return {
      documents: docs,
      scanSummary: {
        totalScanned,
        matched: docs.length,
        excluded,
      },
    };
  }

  // --------------------------------------------------------------------------
  // Evidence Ledger Operations
  // --------------------------------------------------------------------------

  async recordEvidence(evidence: SourceEvidence): Promise<void> {
    const evidenceLedger = path.join(
      this.projectsDataDir,
      evidence.projectId,
      "graph",
      "evidence.jsonl"
    );
    const line = JSON.stringify(evidence) + "\n";
    fs.appendFileSync(evidenceLedger, line, "utf-8");
  }

  async listEvidence(projectId: ProjectId): Promise<SourceEvidence[]> {
    const evidenceLedger = path.join(
      this.projectsDataDir,
      projectId,
      "graph",
      "evidence.jsonl"
    );
    if (!fs.existsSync(evidenceLedger)) {
      return [];
    }
    const lines = fs
      .readFileSync(evidenceLedger, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    return lines.map((l) => JSON.parse(l));
  }

  // --------------------------------------------------------------------------
  // Assertion Library
  // --------------------------------------------------------------------------

  assertProjectIsolated(projectA: Project, projectB: Project): void {
    assert.notEqual(projectA.id, projectB.id, "Projects must have unique IDs");
    const dirA = path.join(this.projectsDataDir, projectA.id);
    const dirB = path.join(this.projectsDataDir, projectB.id);
    assert.notEqual(dirA, dirB, "Project directories must not collide");
    assert.ok(fs.existsSync(dirA), `Project A directory ${dirA} must exist`);
    assert.ok(fs.existsSync(dirB), `Project B directory ${dirB} must exist`);
  }

  assertEvidenceActive(evidence: SourceEvidence): void {
    assert.equal(
      evidence.status,
      "active",
      `Expected evidence ${evidence.id} to be active, got ${evidence.status}`
    );
  }

  assertEvidenceSuperseded(evidence: SourceEvidence): void {
    assert.equal(
      evidence.status,
      "superseded",
      `Expected evidence ${evidence.id} to be superseded, got ${evidence.status}`
    );
  }

  assertZeroDuplicateEvidence(evidenceList: SourceEvidence[]): void {
    const seen = new Set<string>();
    for (const ev of evidenceList) {
      const key = `${ev.projectId}:${ev.documentId}:${ev.revisionId}:${ev.propositionId}`;
      assert.ok(
        !seen.has(key),
        `Invariant violation: duplicate evidence detected for ${key}`
      );
      seen.add(key);
    }
  }

  assertDocumentStatus(doc: SourceDocument, expected: SourceDocument["status"]): void {
    assert.equal(
      doc.status,
      expected,
      `Expected document ${doc.currentPath} to have status ${expected}, got ${doc.status}`
    );
  }
}

// ============================================================================
// Internal Helpers
// ============================================================================

function copyDirectoryRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirectoryRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
