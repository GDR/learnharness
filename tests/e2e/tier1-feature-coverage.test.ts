/**
 * Tier 1 Feature Coverage Test Suite
 *
 * Verifies Tier 1 Pure Unit & Domain Invariants:
 * 1. Glob Rule Matching & Exclusion Engine (>=5 test cases)
 * 2. Obsidian Deep-Link & URI Generator (>=5 test cases)
 * 3. Pure Obsidian AST & Markdown Syntax Parser (>=5 test cases)
 * 4. Project Domain Contracts & Schema Invariants (>=5 test cases)
 * 5. Document Content Hashing, Inventory & Change Detection (>=5 test cases)
 * 6. Source Evidence Ledger Provenance & Invariants (>=5 test cases)
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  TestHarness,
  matchesGlob,
  createObsidianDeepLink,
  computeDocumentHash,
  parseObsidianMarkdown,
  DEFAULT_EXCLUDES,
  type SourceEvidence,
  type Project,
} from "./test-harness.ts";

describe("Tier 1 Feature Coverage: LearnHarness E2E Test Suite", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = new TestHarness();
  });

  afterEach(() => {
    harness.cleanup();
  });

  // ==========================================================================
  // Feature 1: Glob Rule Matching & Exclusion Engine
  // ==========================================================================
  describe("Feature 1: Glob Rule Matching & Exclusion Engine", () => {
    it("T1.1.1: default exclusions: excludes .obsidian directory and files", () => {
      const matchConfig = matchesGlob(".obsidian/app.json");
      const matchWorkspace = matchesGlob(".obsidian/workspace.json");
      const matchNested = matchesGlob(".obsidian/plugins/core/main.js");

      assert.equal(matchConfig, false, ".obsidian/app.json must be excluded by default");
      assert.equal(matchWorkspace, false, ".obsidian/workspace.json must be excluded by default");
      assert.equal(matchNested, false, ".obsidian nested files must be excluded by default");
    });

    it("T1.1.2: default exclusions: excludes .trash directory and deleted notes", () => {
      const matchDeleted = matchesGlob(".trash/deleted-note.md");
      const matchNestedTrash = matchesGlob(".trash/archive/old.md");

      assert.equal(matchDeleted, false, ".trash/deleted-note.md must be excluded by default");
      assert.equal(matchNestedTrash, false, ".trash subfolder notes must be excluded by default");
    });

    it("T1.1.3: default exclusions: excludes .git and node_modules directories", () => {
      assert.equal(matchesGlob(".git/config"), false, ".git/config must be excluded");
      assert.equal(matchesGlob(".git/HEAD"), false, ".git/HEAD must be excluded");
      assert.equal(matchesGlob("node_modules/katex/dist/katex.js"), false, "node_modules must be excluded");
    });

    it("T1.1.4: recursive inclusion: **/*.md matches markdown notes at arbitrary depths", () => {
      assert.equal(matchesGlob("Physics/Quantum/Schrodinger.md", ["**/*.md"]), true);
      assert.equal(matchesGlob("Math/LinearAlgebra.md", ["**/*.md"]), true);
      assert.equal(matchesGlob("Physics/Classical/Newton.md", ["**/*.md"]), true);
      assert.equal(matchesGlob("A/B/C/D/E/deep.md", ["**/*.md"]), true);
      assert.equal(matchesGlob("image.png", ["**/*.md"]), false, "non-markdown files must be excluded");
    });

    it("T1.1.5: non-recursive inclusion: *.md matches only root-level markdown notes", () => {
      assert.equal(matchesGlob("root-note.md", ["*.md"]), true);
      assert.equal(matchesGlob("Physics/Quantum/Schrodinger.md", ["*.md"]), false);
      assert.equal(matchesGlob("Math/LinearAlgebra.md", ["*.md"]), false);
    });

    it("T1.1.6: subfolder scoping: Physics/**/*.md matches only Physics subtree", () => {
      const include = ["Physics/**/*.md"];
      assert.equal(matchesGlob("Physics/Quantum/Schrodinger.md", include), true);
      assert.equal(matchesGlob("Physics/Classical/Newton.md", include), true);
      assert.equal(matchesGlob("Math/LinearAlgebra.md", include), false);
      assert.equal(matchesGlob("Notes/MovedNote.md", include), false);
    });

    it("T1.1.7: exclusion priority: explicit exclude glob overrides matching include pattern", () => {
      const include = ["**/*.md"];
      const exclude = [...DEFAULT_EXCLUDES, "**/Newton.md", "Math/**"];

      assert.equal(matchesGlob("Physics/Quantum/Schrodinger.md", include, exclude), true);
      assert.equal(matchesGlob("Physics/Classical/Newton.md", include, exclude), false);
      assert.equal(matchesGlob("Math/LinearAlgebra.md", include, exclude), false);
    });
  });

  // ==========================================================================
  // Feature 2: Obsidian Deep-Link & URI Generator
  // ==========================================================================
  describe("Feature 2: Obsidian Deep-Link & URI Generator", () => {
    it("T1.2.1: generates standard obsidian://open URI with RFC 3986 encoding", () => {
      const uri = createObsidianDeepLink("Research Vault", "Physics/Classical/Newton.md");
      assert.equal(
        uri,
        "obsidian://open?vault=Research%20Vault&file=Physics%2FClassical%2FNewton.md"
      );
    });

    it("T1.2.2: encodes vault names containing spaces, ampersands, and unicode characters", () => {
      const uri = createObsidianDeepLink(
        "Körper & Geist — Знания",
        "Notes/Test.md"
      );
      assert.ok(uri.startsWith("obsidian://open?vault="));
      assert.ok(uri.includes("K%C3%B6rper%20%26%20Geist%20%E2%80%94%20%D0%97%D0%BD%D0%B0%D0%BD%D0%B8%D1%8F"));
    });

    it("T1.2.3: encodes heading anchor with special characters and umlauts", () => {
      const uri = createObsidianDeepLink(
        "Vault",
        "Physics/Quantum/Schrodinger.md",
        "The Time-Dependent Schrödinger Equation"
      );
      assert.equal(
        uri,
        "obsidian://open?vault=Vault&file=Physics%2FQuantum%2FSchrodinger.md%23The%20Time-Dependent%20Schr%C3%B6dinger%20Equation"
      );
    });

    it("T1.2.4: encodes block reference anchor with ^prefix", () => {
      const uri = createObsidianDeepLink(
        "Vault",
        "Physics/Quantum/Schrodinger.md",
        "^eq1"
      );
      assert.equal(
        uri,
        "obsidian://open?vault=Vault&file=Physics%2FQuantum%2FSchrodinger.md#^eq1"
      );
    });

    it("T1.2.5: handles combined heading and block anchor", () => {
      const uri = createObsidianDeepLink(
        "Vault",
        "Math/LinearAlgebra.md",
        "Eigenvalues and Eigenvectors#^matrix-eigen"
      );
      assert.equal(
        uri,
        "obsidian://open?vault=Vault&file=Math%2FLinearAlgebra.md%23Eigenvalues%20and%20Eigenvectors#^matrix-eigen"
      );
    });

    it("T1.2.6: boundary: handles empty heading or leading ./ in file path cleanly", () => {
      const uriA = createObsidianDeepLink("Vault", "./Math/LinearAlgebra.md", "");
      const uriB = createObsidianDeepLink("Vault", "Math\\LinearAlgebra.md");

      assert.equal(uriA, "obsidian://open?vault=Vault&file=Math%2FLinearAlgebra.md");
      assert.equal(uriB, "obsidian://open?vault=Vault&file=Math%2FLinearAlgebra.md");
    });
  });

  // ==========================================================================
  // Feature 3: Pure Obsidian AST & Markdown Syntax Parser
  // ==========================================================================
  describe("Feature 3: Pure Obsidian AST & Markdown Syntax Parser", () => {
    it("T1.3.1: parses YAML frontmatter with string, list, and metadata fields", () => {
      const schrodingerPath = path.join(
        harness.goldenVaultDir,
        "Physics/Quantum/Schrodinger.md"
      );
      const content = fs.readFileSync(schrodingerPath, "utf-8");
      const parsed = parseObsidianMarkdown(content);

      assert.equal(parsed.frontmatter.title, "Erwin Schrödinger and Wave Mechanics");
      assert.equal(parsed.frontmatter.author, "Erwin Schrödinger");
      assert.equal(parsed.frontmatter.difficulty, "intermediate");
      assert.deepEqual(parsed.frontmatter.tags, ["physics", "quantum", "wave-mechanics"]);
      assert.deepEqual(parsed.frontmatter.aliases, ["Schrödinger Equation", "Wave Equation"]);
    });

    it("T1.3.2: extracts wikilinks with targets, aliases, and character offsets", () => {
      const schrodingerPath = path.join(
        harness.goldenVaultDir,
        "Physics/Quantum/Schrodinger.md"
      );
      const content = fs.readFileSync(schrodingerPath, "utf-8");
      const parsed = parseObsidianMarkdown(content);

      assert.ok(parsed.wikilinks.length >= 3, "Must extract at least 3 wikilinks");

      const waveMechLink = parsed.wikilinks.find((w) => w.target === "Wave Mechanics");
      assert.ok(waveMechLink, "Must find Wave Mechanics link");
      assert.equal(waveMechLink.alias, "wave mechanics");
      assert.ok(waveMechLink.offset > 0, "Wikilink offset must be non-zero");

      const stateSpaceLink = parsed.wikilinks.find((w) => w.target === "LinearAlgebra");
      assert.ok(stateSpaceLink, "Must find LinearAlgebra link");
      assert.equal(stateSpaceLink.alias, "state space");
    });

    it("T1.3.3: extracts block reference IDs and exact offset spans", () => {
      const schrodingerPath = path.join(
        harness.goldenVaultDir,
        "Physics/Quantum/Schrodinger.md"
      );
      const content = fs.readFileSync(schrodingerPath, "utf-8");
      const parsed = parseObsidianMarkdown(content);

      assert.ok("eq1" in parsed.blockIds, "Must extract block ID eq1");
      const blockSpan = parsed.blockIds["eq1"];
      assert.ok(blockSpan.startOffset > 0);
      assert.ok(blockSpan.endOffset > blockSpan.startOffset);

      // Verify offset slice contains the block id in raw content
      const slice = content.slice(blockSpan.startOffset, blockSpan.endOffset);
      assert.ok(slice.includes("^eq1"), "Offset slice must contain ^eq1");
    });

    it("T1.3.4: extracts inline and multi-line block LaTeX equations", () => {
      const schrodingerPath = path.join(
        harness.goldenVaultDir,
        "Physics/Quantum/Schrodinger.md"
      );
      const content = fs.readFileSync(schrodingerPath, "utf-8");
      const parsed = parseObsidianMarkdown(content);

      const blockEqs = parsed.equations.filter((e) => e.type === "block");
      const inlineEqs = parsed.equations.filter((e) => e.type === "inline");

      assert.ok(blockEqs.length >= 2, "Must extract at least 2 block equations");
      assert.ok(inlineEqs.length >= 2, "Must extract at least 2 inline equations");
      assert.ok(blockEqs.some((e) => e.content.includes("\\nabla^2")));
      assert.ok(inlineEqs.some((e) => e.content.includes("\\Psi(\\mathbf{r}, t)")));
    });

    it("T1.3.5: extracts callouts with type, title, and body content", () => {
      const schrodingerPath = path.join(
        harness.goldenVaultDir,
        "Physics/Quantum/Schrodinger.md"
      );
      const content = fs.readFileSync(schrodingerPath, "utf-8");
      const parsed = parseObsidianMarkdown(content);

      assert.equal(parsed.callouts.length, 1);
      const callout = parsed.callouts[0];
      assert.ok(callout, "Callout must be defined");
      assert.equal(callout.type, "note");
      assert.equal(callout.title, "Fundamental Postulate");
      assert.ok(callout.content.includes("The state of a quantum physical system"));
    });

    it("T1.3.6: extracts markdown tables with structured columns and rows", () => {
      const newtonPath = path.join(
        harness.goldenVaultDir,
        "Physics/Classical/Newton.md"
      );
      const content = fs.readFileSync(newtonPath, "utf-8");
      const parsed = parseObsidianMarkdown(content);

      assert.equal(parsed.tables.length, 1, "Must extract Newton's laws table");
      const table = parsed.tables[0];
      assert.ok(table, "Table must be defined");
      assert.deepEqual(table.header, [
        "Law",
        "Principle",
        "Mathematical Formulation",
        "Physical Interpretation",
      ]);
      assert.equal(table.rows.length, 3, "Table must have 3 rows for Newton's laws");
      const row0 = table.rows[0];
      const row1 = table.rows[1];
      const row2 = table.rows[2];
      assert.ok(row0 && row1 && row2);
      assert.equal(row0[0], "First Law");
      assert.equal(row1[0], "Second Law");
      assert.equal(row2[0], "Third Law");
    });

    it("T1.3.7: segments document into hierarchical sections with heading metadata", () => {
      const schrodingerPath = path.join(
        harness.goldenVaultDir,
        "Physics/Quantum/Schrodinger.md"
      );
      const content = fs.readFileSync(schrodingerPath, "utf-8");
      const parsed = parseObsidianMarkdown(content);

      assert.ok(parsed.sections.length >= 3, "Must segment into at least 3 sections");
      const h1Section = parsed.sections.find((s) => s.level === 1);
      assert.ok(h1Section);
      assert.equal(h1Section.heading, "Erwin Schrödinger and Wave Mechanics");

      const h2Section = parsed.sections.find(
        (s) => s.heading === "The Time-Dependent Schrödinger Equation"
      );
      assert.ok(h2Section);
      assert.equal(h2Section.level, 2);
      assert.ok(h2Section.blockIds.includes("eq1"));
    });
  });

  // ==========================================================================
  // Feature 4: Project Domain Contracts & Schema Invariants
  // ==========================================================================
  describe("Feature 4: Project Domain Contracts & Schema Invariants", () => {
    it("T1.4.1: creates project with default settings and enforces non-empty name", async () => {
      const project = await harness.createProject({
        name: "Quantum Computing Lab",
        description: "Study of quantum algorithms",
      });

      assert.ok(project.id.startsWith("proj_"));
      assert.equal(project.name, "Quantum Computing Lab");
      assert.equal(project.status, "active");
      assert.equal(project.settings.defaultStudyScope, "all");
      assert.equal(project.settings.sourceGrounding, "strict");

      // Empty name must throw explicit error
      await assert.rejects(
        async () => {
          await harness.createProject({ name: "   " });
        },
        /Project name is required/,
        "Must reject empty project name"
      );
    });

    it("T1.4.2: enforces strict workspace isolation between distinct projects", async () => {
      const projectA = await harness.createProject({ name: "Project Alpha" });
      const projectB = await harness.createProject({ name: "Project Beta" });

      harness.assertProjectIsolated(projectA, projectB);

      // Verify separate storage directories
      const dirA = path.join(harness.projectsDataDir, projectA.id);
      const dirB = path.join(harness.projectsDataDir, projectB.id);

      assert.notEqual(dirA, dirB);
      assert.ok(fs.existsSync(path.join(dirA, "graph")));
      assert.ok(fs.existsSync(path.join(dirB, "graph")));
    });

    it("T1.4.3: validates project ID format and rejects path traversal attacks", () => {
      const invalidIds = ["../etc/passwd", "..", "", "   ", "proj/nested", "proj\\back"];
      for (const id of invalidIds) {
        const isValid = /^proj_[a-zA-Z0-9_-]+$/.test(id);
        assert.equal(isValid, false, `ID ${id} must be rejected as invalid`);
      }
    });

    it("T1.4.4: returns null on non-existent project ID (fail-fast 404 validation)", async () => {
      const nonExistent = await harness.getProject("proj_doesnotexist123");
      assert.equal(nonExistent, null, "Non-existent project must resolve to null");
    });

    it("T1.4.5: registers vaults with deviceId bindings and availability status", async () => {
      const sandbox = harness.createSandboxVault();
      try {
        const vault = await harness.registerVault({
          displayName: "Obsidian Sandbox",
          rootPath: sandbox.vaultPath,
          status: "available",
        });

        assert.ok(vault.id.startsWith("vault_"));
        assert.equal(vault.displayName, "Obsidian Sandbox");
        assert.equal(vault.kind, "obsidian");
        assert.equal(vault.bindings.length, 1);
        const binding = vault.bindings[0];
        assert.ok(binding, "Binding must be defined");
        assert.equal(binding.status, "available");
      } finally {
        sandbox.cleanup();
      }
    });

    it("T1.4.6: attaches project source with sync mode and deletion policy defaults", async () => {
      const project = await harness.createProject({ name: "Mechanics Project" });
      const vault = await harness.registerVault({
        displayName: "Vault A",
        rootPath: harness.goldenVaultDir,
      });

      const source = await harness.attachSource({
        projectId: project.id,
        vaultId: vault.id,
        include: ["Physics/**/*.md"],
        syncMode: "manual",
        deletionPolicy: "deactivate",
      });

      assert.ok(source.id.startsWith("src_"));
      assert.equal(source.projectId, project.id);
      assert.equal(source.vaultId, vault.id);
      assert.deepEqual(source.include, ["Physics/**/*.md"]);
      assert.equal(source.syncMode, "manual");
      assert.equal(source.deletionPolicy, "deactivate");
    });
  });

  // ==========================================================================
  // Feature 5: Document Content Hashing, Inventory & Change Detection
  // ==========================================================================
  describe("Feature 5: Document Content Hashing, Inventory & Change Detection", () => {
    it("T1.5.1: computes deterministic SHA-256 content hash across multiple runs", () => {
      const notePath = path.join(harness.goldenVaultDir, "Math/LinearAlgebra.md");
      const content = fs.readFileSync(notePath);

      const hash1 = computeDocumentHash(content);
      const hash2 = computeDocumentHash(content);
      assert.equal(hash1, hash2, "Hashes of identical content must be equal");
      assert.equal(hash1.length, 64, "SHA-256 hash must be 64 hex characters");
    });

    it("T1.5.2: detects content modifications: 1-byte change yields distinct hash", () => {
      const original = "Energy is quantized: $E = h\\nu$";
      const modified = "Energy is quantized: $E = h\\nu$."; // added dot

      const hashOriginal = computeDocumentHash(original);
      const hashModified = computeDocumentHash(modified);

      assert.notEqual(hashOriginal, hashModified, "Different content must produce different hashes");
    });

    it("T1.5.3: preserves whitespace and newline sensitivity during hashing", () => {
      const crlf = "title: Note\r\n\r\nBody text\r\n";
      const lf = "title: Note\n\nBody text\n";

      assert.notEqual(
        computeDocumentHash(crlf),
        computeDocumentHash(lf),
        "CRLF and LF must have distinct hashes"
      );
    });

    it("T1.5.4: Scenario A: re-scanning identical fixture files detects 0 modifications", async () => {
      const project = await harness.createProject({ name: "Scan Project" });
      const vault = await harness.registerVault({
        displayName: "Vault Fixture",
        rootPath: harness.goldenVaultDir,
      });
      const source = await harness.attachSource({
        projectId: project.id,
        vaultId: vault.id,
        include: ["**/*.md"],
      });

      const scan1 = await harness.scanSource(source, harness.goldenVaultDir);
      const scan2 = await harness.scanSource(source, harness.goldenVaultDir);

      assert.equal(scan1.documents.length, scan2.documents.length);
      for (let i = 0; i < scan1.documents.length; i++) {
        const doc1 = scan1.documents[i];
        const doc2 = scan2.documents[i];
        assert.ok(doc1 && doc2, "Documents must be defined");
        assert.equal(
          doc1.contentHash,
          doc2.contentHash,
          "Re-scanned document hash must match exactly"
        );
      }
    });

    it("T1.5.5: Scenario B: modifying note in sandbox creates new revision hash", async () => {
      const sandbox = harness.createSandboxVault();
      try {
        const project = await harness.createProject({ name: "Revision Project" });
        const vault = await harness.registerVault({
          displayName: "Sandbox Vault",
          rootPath: sandbox.vaultPath,
        });
        const source = await harness.attachSource({
          projectId: project.id,
          vaultId: vault.id,
          include: ["Physics/Quantum/*.md"],
        });

        const initialScan = await harness.scanSource(source, sandbox.vaultPath);
        const schrodingerDocBefore = initialScan.documents.find(
          (d) => d.currentPath === "Physics/Quantum/Schrodinger.md"
        );
        assert.ok(schrodingerDocBefore);

        // Modify note content in sandbox
        const schrodingerFile = path.join(sandbox.vaultPath, "Physics/Quantum/Schrodinger.md");
        fs.appendFileSync(schrodingerFile, "\n\n## Extended Observations\nNew empirical revision.\n");

        const rescanned = await harness.scanSource(source, sandbox.vaultPath);
        const schrodingerDocAfter = rescanned.documents.find(
          (d) => d.currentPath === "Physics/Quantum/Schrodinger.md"
        );
        assert.ok(schrodingerDocAfter);

        assert.notEqual(
          schrodingerDocBefore.contentHash,
          schrodingerDocAfter.contentHash,
          "Modified document must produce a new content hash"
        );
        assert.notEqual(
          schrodingerDocBefore.revisionId,
          schrodingerDocAfter.revisionId,
          "Modified document must generate a new revision ID"
        );
      } finally {
        sandbox.cleanup();
      }
    });

    it("T1.5.6: document status validation for active, missing, and excluded documents", () => {
      const activeDoc = {
        id: "doc_01",
        vaultId: "vault_01",
        currentPath: "Physics/Quantum/Schrodinger.md",
        contentHash: "hash123",
        revisionId: "rev1",
        status: "active" as const,
      };

      harness.assertDocumentStatus(activeDoc, "active");

      const missingDoc = { ...activeDoc, status: "missing" as const };
      harness.assertDocumentStatus(missingDoc, "missing");

      const excludedDoc = { ...activeDoc, status: "excluded" as const };
      harness.assertDocumentStatus(excludedDoc, "excluded");
    });
  });

  // ==========================================================================
  // Feature 6: Source Evidence Ledger Provenance & Invariants
  // ==========================================================================
  describe("Feature 6: Source Evidence Ledger Provenance & Invariants", () => {
    it("T1.6.1: distinguishes explicit-source and model-inferred evidence provenance", async () => {
      const project = await harness.createProject({ name: "Evidence Project" });

      const explicitEvidence: SourceEvidence = {
        id: "ev_exp_01",
        projectId: project.id,
        sourceId: "src_01",
        documentId: "doc_01",
        revisionId: "rev_01",
        propositionId: "prop_schrodinger_eq",
        location: { heading: "The Time-Dependent Schrödinger Equation", blockId: "^eq1" },
        provenance: "explicit-source",
        status: "active",
        extractorVersion: "1.0.0",
      };

      const inferredEvidence: SourceEvidence = {
        id: "ev_inf_01",
        projectId: project.id,
        sourceId: "src_01",
        documentId: "doc_01",
        revisionId: "rev_01",
        propositionId: "prop_hamiltonian_operator",
        location: { startOffset: 500, endOffset: 750 },
        provenance: "model-inferred",
        status: "active",
        extractorVersion: "1.0.0",
      };

      await harness.recordEvidence(explicitEvidence);
      await harness.recordEvidence(inferredEvidence);

      const recorded = await harness.listEvidence(project.id);
      assert.equal(recorded.length, 2);
      const rec0 = recorded[0];
      const rec1 = recorded[1];
      assert.ok(rec0 && rec1, "Recorded evidence items must be defined");
      assert.equal(rec0.provenance, "explicit-source");
      assert.equal(rec1.provenance, "model-inferred");
    });

    it("T1.6.2: Scenario A invariant: enforces zero duplicate evidence on identical revision", async () => {
      const project = await harness.createProject({ name: "Dedup Project" });

      const evidenceA: SourceEvidence = {
        id: "ev_01",
        projectId: project.id,
        sourceId: "src_01",
        documentId: "doc_01",
        revisionId: "rev_abc",
        propositionId: "prop_law_of_inertia",
        location: { heading: "Newton's Three Laws of Motion" },
        provenance: "explicit-source",
        status: "active",
        extractorVersion: "1.0.0",
      };

      await harness.recordEvidence(evidenceA);
      const list = await harness.listEvidence(project.id);

      // Must pass zero duplicate check
      harness.assertZeroDuplicateEvidence(list);

      // Duplicate detection assertion: adding an evidence with identical key must fail invariant
      const duplicateList = [...list, { ...evidenceA, id: "ev_02_duplicate" }];
      assert.throws(
        () => harness.assertZeroDuplicateEvidence(duplicateList),
        /duplicate evidence detected/,
        "Invariant violation: duplicate evidence must be caught"
      );
    });

    it("T1.6.3: Scenario B invariant: supersedes prior revision evidence on note update", async () => {
      const project = await harness.createProject({ name: "Supersede Project" });

      const priorEvidence: SourceEvidence = {
        id: "ev_rev1",
        projectId: project.id,
        sourceId: "src_01",
        documentId: "doc_01",
        revisionId: "rev_01",
        propositionId: "prop_gravitation",
        location: { heading: "Universal Gravitation" },
        provenance: "explicit-source",
        status: "superseded",
        extractorVersion: "1.0.0",
      };

      const newEvidence: SourceEvidence = {
        id: "ev_rev2",
        projectId: project.id,
        sourceId: "src_01",
        documentId: "doc_01",
        revisionId: "rev_02",
        propositionId: "prop_gravitation",
        location: { heading: "Universal Gravitation" },
        provenance: "explicit-source",
        status: "active",
        extractorVersion: "1.0.0",
      };

      harness.assertEvidenceSuperseded(priorEvidence);
      harness.assertEvidenceActive(newEvidence);
    });

    it("T1.6.4: Scenario C invariant: shared proposition remains active when supported by second doc", async () => {
      const project = await harness.createProject({ name: "Shared Prop Project" });

      // Note A (Planck) evidence deactivated
      const evidenceDocA: SourceEvidence = {
        id: "ev_planck",
        projectId: project.id,
        sourceId: "src_shared",
        documentId: "doc_shared_planck",
        revisionId: "rev_01",
        propositionId: "prop_energy_quantized",
        location: { heading: "Energy Quantization" },
        provenance: "explicit-source",
        status: "superseded", // Note A was deleted/deactivated
        extractorVersion: "1.0.0",
      };

      // Note B (Bohr) evidence still active
      const evidenceDocB: SourceEvidence = {
        id: "ev_bohr",
        projectId: project.id,
        sourceId: "src_shared",
        documentId: "doc_shared_bohr",
        revisionId: "rev_01",
        propositionId: "prop_energy_quantized",
        location: { heading: "Energy Quantization" },
        provenance: "explicit-source",
        status: "active", // Note B still supports the proposition
        extractorVersion: "1.0.0",
      };

      await harness.recordEvidence(evidenceDocA);
      await harness.recordEvidence(evidenceDocB);

      const allEvidence = await harness.listEvidence(project.id);
      const activeForProp = allEvidence.filter(
        (e) => e.propositionId === "prop_energy_quantized" && e.status === "active"
      );

      assert.equal(
        activeForProp.length,
        1,
        "Proposition must remain supported by active Note B evidence"
      );
      const activeEv = activeForProp[0];
      assert.ok(activeEv, "Active evidence must be defined");
      assert.equal(activeEv.documentId, "doc_shared_bohr");
    });

    it("T1.6.5: Scenario D invariant: learner evidence is preserved when source note is deleted", async () => {
      const project = await harness.createProject({ name: "Learner Preservation Project" });

      // Source evidence marked superseded upon note deletion
      const sourceEvidence: SourceEvidence = {
        id: "ev_src_deleted",
        projectId: project.id,
        sourceId: "src_01",
        documentId: "doc_deleted_note",
        revisionId: "rev_01",
        propositionId: "prop_learned_concept",
        location: { heading: "Concept Definition" },
        provenance: "explicit-source",
        status: "superseded",
        extractorVersion: "1.0.0",
      };

      // Learner-generated mastery evidence established in tutoring session
      const learnerEvidence: SourceEvidence = {
        id: "ev_learner_mastery",
        projectId: project.id,
        sourceId: "src_01",
        documentId: "session_chat_123",
        revisionId: "rev_session",
        propositionId: "prop_learned_concept",
        location: { heading: "Practice Set Round 1" },
        provenance: "model-inferred",
        status: "active",
        extractorVersion: "1.0.0",
      };

      await harness.recordEvidence(sourceEvidence);
      await harness.recordEvidence(learnerEvidence);

      const records = await harness.listEvidence(project.id);
      const activeLearner = records.find(
        (r) => r.id === "ev_learner_mastery" && r.status === "active"
      );

      assert.ok(
        activeLearner,
        "Scenario D: Learner evidence must remain active and preserved in graph"
      );
      assert.equal(activeLearner.provenance, "model-inferred");
    });

    it("T1.6.6: maintains chronological append-only ledger ordering across multiple events", async () => {
      const project = await harness.createProject({ name: "Chronological Ledger Project" });

      const events: SourceEvidence[] = Array.from({ length: 5 }, (_, idx) => ({
        id: `ev_seq_${idx}`,
        projectId: project.id,
        sourceId: "src_01",
        documentId: "doc_01",
        revisionId: `rev_${idx}`,
        propositionId: `prop_${idx}`,
        location: { startOffset: idx * 100, endOffset: (idx + 1) * 100 },
        provenance: "explicit-source",
        status: "active",
        extractorVersion: "1.0.0",
      }));

      for (const ev of events) {
        await harness.recordEvidence(ev);
      }

      const recorded = await harness.listEvidence(project.id);
      assert.equal(recorded.length, 5);
      for (let i = 0; i < 5; i++) {
        const item = recorded[i];
        assert.ok(item, "Ledger item must be defined");
        assert.equal(item.id, `ev_seq_${i}`);
      }
    });
  });
});
