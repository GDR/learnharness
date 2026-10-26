# LearnHarness E2E Test Suite Infrastructure & Testing Specification

## 1. Executive Overview & Testing Philosophy

LearnHarness enforces a rigorous multi-project workspace isolation and incremental Obsidian vault ingestion pipeline. To guarantee total correctness, reliability, and data safety across all operational invariants, the testing infrastructure employs a **Dual Track Testing Architecture**:

```text
               ┌────────────────────────────────────────────────────────┐
               │              Dual Track Test Architecture              │
               └────────────────────────────────────────────────────────┘
                                /                         \
                               /                           \
               ┌────────────────────────┐      ┌─────────────────────────┐
               │ Track 1: Fast In-Proc  │      │ Track 2: Realistic E2E  │
               │ Deterministic / Faux   │      │ Fixture Vault & HTTP    │
               │ (Sub-millisecond Tiers)│      │ (Full Scenarios A–F)    │
               └────────────────────────┘      └─────────────────────────┘
```

### Core Invariants Subject to Test Verification
1. **Project Ownership**: A project strictly owns its learning sessions, practice sets, and knowledge graph.
2. **Non-Authoritative Sources**: Source files never become authoritative learner-state records.
3. **Evidence Distinction**: Imported evidence (`"explicit-source" | "model-inferred"`) and learner-generated evidence remain distinguishable.
4. **Evidence Immortality**: Source updates must not silently erase evidence from completed learning sessions.
5. **M:N Multi-Tenancy**: A project may reference multiple sources; a source may be referenced by multiple projects.
6. **Scenario A (Idempotence)**: Repeating the same import must not duplicate graph evidence.
7. **Traceability**: Every extracted claim must be traceable to its source document and source revision.
8. **Read-Only Ingestion**: Background source ingestion is strictly read-only and never modifies Obsidian notes.
9. **Explicit Context Resolution**: Cross-project data access must be explicit; missing or invalid `projectId` fails immediately with HTTP 400/404 without silent fallback.
10. **Transaction Integrity**: Failed indexing must not corrupt the last successfully committed graph.

---

## 2. Test Design Methodologies

### 2.1 Category-Partition Method

The Category-Partition method decomposes the input domain and execution environment into functional categories, equivalence partitions, and combinatorial constraints:

| Category | Parameter | Equivalence Partitions | Constraints & Edge Cases |
| :--- | :--- | :--- | :--- |
| **Project Identity** | `projectId` | Valid alphanumeric (`proj_[a-z0-9_-]+`), empty string, whitespace only, malformed characters (`../../etc/passwd`), non-existent ID | Fail fast on invalid format (400) or missing ID (404); never route to default |
| **Vault Binding** | `status` | `available`, `unavailable` | Disconnected vault preserves document inventory; never treat as mass deletion |
| **Vault Path** | `rootPath` | Absolute valid dir, relative path, non-existent path, symlinked directory, read-only dir | Must normalize paths; prevent path traversal outside vault root |
| **Source Matching** | `include` globs | `**/*.md`, `Physics/**/*.md`, non-recursive `*.md`, empty array | Case sensitivity, path separators (`/` vs `\`), glob boundaries |
| **Source Exclusion** | `exclude` globs | Defaults (`.obsidian/**`, `.trash/**`, `.git/**`, `node_modules/**`), custom globs (`**/*.draft.md`) | Exclusion overrides inclusion; hidden directories pruned during tree walk |
| **Note Syntax** | Markdown constructs | Frontmatter (YAML), headings (H1-H6), LaTeX inline (`$...$`), LaTeX block (`$$...$$`), block ref (`^id`), callout (`> [!type]`), wikilink (`[[target\|alias]]`), tags (`#tag`), tables, fenced code | Zero offset drift; offsets must reference exact slice in raw note file |
| **Change Detection**| File State | Unchanged (identical SHA-256), Modified (different SHA-256), Moved (same SHA-256, new path), Deleted (missing on disk) | Scenario A (skip), Scenario B (supersede), Move tracking (preserve revision) |
| **Evidence Lifecycle**| `provenance` | `explicit-source`, `model-inferred` | Preserved across note deletion (Scenario D) |
| **Graph Commits** | Commits | Single writer, concurrent writers (Scenario E), crash during write (Scenario F) | Mutex serialization; generation-based atomic rename recovery |

### 2.2 Boundary Value Analysis (BVA)

Tests explicitly target the extreme edges of all input and data domains:
1. **Document Content**:
   - 0-byte empty file.
   - Note with only YAML frontmatter and no markdown body.
   - Note with no frontmatter and only body.
   - Huge notes (>100KB, >10,000 lines).
   - Files without trailing newline (`\n`).
2. **Offset Boundaries**:
   - Section starting at offset `0`.
   - Block references at the exact end of document (`EOF`).
   - Unicode multi-byte characters (e.g. `Schrödinger`, emojis, math symbols $\hbar$) to verify character vs byte offset calculations.
3. **Hierarchy & Scale Boundaries**:
   - Deeply nested directories (`A/B/C/D/E/F/note.md`).
   - Root-level notes vs subfolder notes.
   - Large folder warning threshold: exactly 50 notes vs 51 notes (`learnharness:study-current-folder`).
4. **Identifier Formatting**:
   - Maximum project name length (100 characters).
   - Leading/trailing whitespace trimming.
   - Vault display names containing punctuation, slashes, and spaces.

### 2.3 Pairwise & Combinatorial Testing

Combinatorial coverage ensures multi-variable feature interactions are validated without exhaustive exponential explosion:

| Test Combination | `syncMode` | `deletionPolicy` | Vault Status | Note State | Expected Behavior |
| :---: | :---: | :---: | :---: | :---: | :--- |
| **C1** | `manual` | `deactivate` | `available` | Deleted | File removed on scan; evidence marked `superseded`/inactive |
| **C2** | `manual` | `retain` | `available` | Deleted | File removed on scan; evidence retained as historical record |
| **C3** | `automatic` | `deactivate` | `unavailable`| Missing | Vault disconnected; document inventory and evidence untouched |
| **C4** | `automatic` | `retain` | `unavailable`| Missing | Vault disconnected; no deletion events generated |
| **C5** | `manual` | `deactivate` | `available` | Modified | New revision created; prior revision marked `superseded` (Scenario B) |
| **C6** | `automatic` | `retain` | `available` | Unchanged | Hash match; zero indexing jobs spawned; 0 ledger events (Scenario A) |

### 2.4 Workload & Concurrency Testing
- **Scenario E**: Two concurrent scanning/indexing tasks launched concurrently on the same project must acquire project-keyed locks (`getProjectAuditLock`), serializing ledger appends so generation numbers remain strictly monotonically increasing.
- **Scenario F**: Simulated crash/abort during graph commit: temporary files (`.tmp`) left on disk are ignored or cleaned, and uncommitted staging states do not corrupt the active ledger (`nodes.jsonl`, `evidence.jsonl`).

---

## 3. Test Tier Architecture

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ Tier 5: Adversarial Hardening (Fault injection, race conditions, fuzzing)    │
├─────────────────────────────────────────────────────────────────────────────┤
│ Tier 4: E2E Route Handlers & Bridge Integration (Next.js APIs, Bridge Auth) │
├─────────────────────────────────────────────────────────────────────────────┤
│ Tier 3: In-Process Full Lifecycle (Scenarios A–F against Fixture Vault)     │
├─────────────────────────────────────────────────────────────────────────────┤
│ Tier 2: Storage & State Machine Integration (Isolated Temp File Systems)    │
├─────────────────────────────────────────────────────────────────────────────┤
│ Tier 1: Pure Unit Tests (Zero I/O, Sub-millisecond Parser & Globs)          │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Tier 1: Pure Unit Tests (Zero I/O, Sub-millisecond)
- **Obsidian Markdown Parser**:
  - AST extraction of YAML frontmatter, headings, tables, fenced code blocks, LaTeX (`$...$`, `$$...$$`), wiki-links (`[[target|alias]]`), block refs (`^block-id`), tags (`#tag`), and callouts (`> [!note]`).
  - Strict preservation of byte and character offsets without AST reserialization.
- **Glob Rule Matching**:
  - Default exclusions (`.obsidian/**`, `.trash/**`, `.git/**`, `node_modules/**`).
  - Include rules (`**/*.md`, `**/*.mdx`).
- **Deep-Link URL Generator**:
  - URI encoding for vault names, special characters, unicode spaces, heading anchors, and block references.

### Tier 2: Storage & State Machine Integration (Isolated Temp Dirs)
- **ProjectStore & ProjectContext**:
  - Two projects containing identical proposition text maintain separate ledgers, chats, and jobs.
  - Missing or invalid `projectId` throws explicit 404/400 errors (never falls back to global).
  - Restart-safe atomic migration from legacy flat storage to `data/projects/<id>/`.
- **VaultRegistry & SourceStore**:
  - Disconnected vault handling: marked `unavailable` without deleting document inventory.
  - Concurrent index serialization: Mutex locks ensure only one graph-commit writer at a time per project.

### Tier 3: In-Process Full-Lifecycle Verification (Scenarios A–F)
Tests execute against the fixture Obsidian vault using `@earendil-works/pi-ai` faux core:
- **Scenario A (Unchanged Document)**: Re-scanning identical file hash generates zero evidence events; extraction stage is skipped.
- **Scenario B (Modified Proposition)**: Edit note text in fixture note → new revision created → new evidence extracted → prior revision marked `superseded`.
- **Scenario C (Shared Proposition)**: Proposition P is supported by Document 1 and Document 2. Deleting Document 1 marks its evidence inactive, but proposition P remains active in the graph because Document 2 still supports it.
- **Scenario D (Learner-Generated Concept Preservation)**: Learner masters concept in tutoring session. Attached source note is deleted. Source evidence is deactivated, but learner understanding observations and graph node are retained.
- **Scenario E (Concurrent Indexing)**: Two concurrent indexing jobs on the same project are serialized by generation locks, preventing corrupted JSONL ledgers.
- **Scenario F (Interrupted Commit / Crash Recovery)**: Process abort simulated during merger phase. On resume, ledger replay commits cleanly without partial writes or duplicate nodes.

### Tier 4: End-to-End Route Handlers & Bridge Integration
- HTTP calls to Next.js route handlers (`app/api/projects/...`, `/api/vaults/...`, `/api/projects/:id/ask`).
- Verification of status codes, headers, and payload shapes.
- Bridge plugin authentication checks (403 without capability header, 200 with valid secret).

### Tier 5: Adversarial Coverage Hardening
- White-box gap analysis, edge cases, malformed payloads, file permission boundaries, and race conditions.

---

## 4. Fixture Vault Architecture (`tests/fixtures/obsidian-vault/`)

The fixture vault provides realistic, representative Markdown notes with rich knowledge structures:

```text
tests/fixtures/obsidian-vault/
├── .obsidian/
│   └── app.json                         # Hidden configuration folder (for exclusion testing)
├── .trash/
│   └── deleted-note.md                  # Trash folder (for exclusion testing)
├── Physics/
│   ├── Quantum/
│   │   ├── Schrodinger.md               # Frontmatter, math ($ and $$), callout, block ref (^eq1), wikilinks
│   │   └── WaveMechanics.md             # Wikilink target note, de Broglie hypothesis
│   └── Classical/
│       └── Newton.md                    # Tables, wikilinks, tags (#physics #mechanics)
├── Math/
│   └── LinearAlgebra.md                 # Matrices, equations, block ref (^matrix-eigen), wikilinks
├── Shared/
│   ├── EnergyQuantizationA.md           # Scenario C: Co-supports proposition "energy is quantized" (Planck)
│   └── EnergyQuantizationB.md           # Scenario C: Co-supports proposition "energy is quantized" (Bohr)
└── Notes/
    └── MovedNote.md                     # Rename and path tracking tests
```

### Note Feature Matrix

| Fixture Note | YAML Frontmatter | Math ($ / $$) | Callouts | Block Refs | Wikilinks | Tables | Tags | Primary Test Target |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| `Physics/Quantum/Schrodinger.md` | Yes | Both | Yes (`[!note]`) | `^eq1` | Yes | No | `#quantum #physics` | Complex AST parsing, offsets, citations |
| `Physics/Classical/Newton.md` | Yes | Inline | No | No | Yes | Yes (3x4) | `#physics #mechanics` | Markdown tables, wikilinks, tags |
| `Math/LinearAlgebra.md` | Yes | Block | No | `^matrix-eigen` | Yes | No | `#math #linear-algebra` | Matrix LaTeX formatting, block refs |
| `Physics/Quantum/WaveMechanics.md` | Yes | Block | No | No | Yes | No | `#quantum #wave-mechanics` | Wikilink target resolution |
| `Shared/EnergyQuantizationA.md` | Yes | Inline | No | No | No | No | `#quantum #thermodynamics` | Scenario C shared proposition |
| `Shared/EnergyQuantizationB.md` | Yes | Inline | No | No | No | No | `#quantum #atomic` | Scenario C shared proposition |
| `Notes/MovedNote.md` | Yes | No | No | No | No | No | `#test #relocation` | Relocation & rename tracking |
| `.trash/deleted-note.md` | Yes | No | No | No | No | No | `#trash` | Default exclusion filter `.trash/**` |
| `.obsidian/app.json` | N/A | No | No | No | No | No | N/A | Hidden dir exclusion `.obsidian/**` |

---

## 5. In-Process Test Harness (`tests/e2e/test-harness.ts`)

The test harness provides an isolated runtime environment with zero test cross-contamination:

### 5.1 TestHarness Capabilities
- **Filesystem Isolation**: Automatically provisions dedicated temporary directories in `os.tmpdir()` for `data/global/` and `data/projects/<id>/`.
- **Sandbox Fixture Vault**: Copies the read-only fixture vault into a mutable temporary directory (`createSandboxVault()`), allowing tests to edit, move, or delete notes without modifying git-tracked golden fixtures.
- **Project Context Factory**: Provisions isolated project stores, vault registries, source stores, and graph stores.
- **Ledger Inspection & Assertions**:
  - `assertProjectIsolated(projectA, projectB)`: Verifies zero shared state between projects.
  - `assertEvidenceActive(evidenceId)`: Confirms evidence status is `"active"`.
  - `assertEvidenceSuperseded(evidenceId)`: Confirms evidence status is `"superseded"`.
  - `assertZeroDuplicateEvidence(ledger)`: Enforces Scenario A invariant.
  - `assertDocumentStatus(docId, status)`: Validates document inventory status.

---

## 6. Execution & Verification Guide

### 6.1 Prerequisites
All commands should be executed inside the Nix development shell:
```bash
nix develop
```

### 6.2 Running Tests
- **Run Tier 1 Feature Coverage Tests**:
  ```bash
  nix develop --command node --test tests/e2e/tier1-feature-coverage.test.ts
  ```
- **Run Full Test Suite**:
  ```bash
  nix develop --command npm test
  ```
- **Run Static Typecheck**:
  ```bash
  nix develop --command npm run typecheck
  ```
- **Run Code Linting**:
  ```bash
  nix develop --command npm run lint
  ```

### 6.3 Test Quality Gates
Every PR and milestone commit must satisfy:
1. `node --test` or `npm test` passes with zero failures.
2. `npm run typecheck` (`tsc --noEmit`) passes with zero errors.
3. `npm run lint` (`eslint .`) passes with zero warnings/errors.
4. Median PR size ~300 LOC (maximum 1000–1500 LOC).
