/**
 * Storage ports (the hexagonal seams — vision §1 "storage stays swappable").
 *
 * One port per ENTITY, with domain operations — never one generic
 * key/value interface. Core and the service layer that orbits it code
 * against these types only; concrete adapters live in src/store/ (fs
 * JSON/JSONL today, SQLite drop-in later) and are wired exactly once, in
 * the composition root (src/server/stores.ts). Dependencies point one way:
 * adapters may import core; core NEVER imports an adapter.
 */

import type { LhMessage } from "./native-messages.ts";
import type {
	ChatRecord,
	ChatSettings,
	ChatSummary,
	GraphChain,
	GraphNode,
	JobKind,
	JobRecord,
	ExtractionRunUsage,
	PlanTree,
	Position,
	CoverageEntry,
	SessionCheckpoint,
	TurnUsage,
	NotesSource,
} from "./contracts.ts";
import type {
	ProjectId,
	Project,
	ProjectSettings,
	VaultId,
	Vault,
	VaultBinding,
	SourceId,
	ProjectSource,
	DocumentId,
	SourceDocument,
	MigrationCheckpoint,
} from "./contracts/project.ts";
export type { MigrationCheckpoint };
import type { SourceEvidence } from "./contracts/evidence.ts";
import type { UserSettings } from "./settings.ts";
import type { LocalAgentPreferences, LocalAgentProviderId } from "./contracts/local-agents.ts";

// ─── ChatStore — the session record's home (data/chats) ─────────────────────

export interface ChatStore {
	/** Create a session record (persisted immediately). */
	/** Create a session record; kind "practice" marks a practice session
	 *  (absent = teach, the default). */
	createChat(title: string, kind?: "practice"): ChatRecord;
	/** The full record, or null if unknown id / corrupt file. */
	getChat(id: string): ChatRecord | null;
	/** All sessions, newest activity first (the sidebar's list view). */
	listChats(): ChatSummary[];
	/** Persist the full native message list (the record IS the agent
	 * state — Wave B, owner-approved 2026-09-26). */
	saveMessages(id: string, messages: LhMessage[]): void;
	/** Persist the session plan tree (plan tools call this in execute). */
	saveTree(id: string, tree: PlanTree): void;
	/** Append one usage entry to the record's turn log (the money channel,
	 * 2026-09): idempotent per turn id — each request carries its own, so
	 * a turn persisted twice appends once while continuation turns (which
	 * share a response message id) each keep their usage. */
	appendTurnUsage(id: string, entry: TurnUsage): void;
	/** Append one extraction-run usage entry — idempotent per startedAt. */
	appendExtractionUsage(id: string, entry: ExtractionRunUsage): void;
	/** Persist the per-chat model/thinking settings (the model control).
	 *  Replace-whole: the picker sends the complete settings object. */
	saveSettings(id: string, settings: ChatSettings): void;
	/** Rename a session (the header's click-to-edit title, 2026-09-17).
	 * Like saveSettings: a rename is NOT conversation activity — updatedAt
	 * stays put, so sidebar order never churns on a rename. */
	renameChat(id: string, title: string): ChatRecord;
	/** Delete the session record entirely (session-deletion wave 6, owner
	 *  2026-09-22). False when the id is unknown. The graph-ledger purge and
	 *  job cleanup are the caller's choreography (core/graph-deletion.ts +
	 *  the DELETE route), not the store's. */
	deleteChat(id: string): boolean;
}

// ─── GraphStore — the append-only evidence ledgers (data/graph) ──────────────
// Chains are the stored truth (owner, 2026-09-30): nodes + reasoning
// chains; edges are a DERIVED view (core/graph.ts) and never touch this
// seam. Reads return the raw append-order lines; merging chain assertions
// by (premises, conclusion) is DERIVED in core/graph.ts — the store never
// decides. The extraction pipeline is the sole writer; this read surface
// stays.

export interface GraphStore {
	/** Append one GraphNode (ids are unique — no merging needed). */
	appendNode(node: GraphNode): void;
	/** Raw node lines in append order. */
	readNodes(): GraphNode[];

	/** Append one chain ASSERTION (a second session asserting the same
	 *  (premises, conclusion) appends another line; readers merge). */
	appendChain(assertion: GraphChain): void;
	readChains(): GraphChain[];

	/** Append one emission checkpoint. */
	appendCheckpoint(checkpoint: SessionCheckpoint): void;
	readCheckpoints(): SessionCheckpoint[];
	/** Message-granular extraction coverage (vision-extraction-coverage.md):
	 *  append-only; one line per covered message. The chat-extraction
	 *  checkpoint — "uncovered" is derived from these, never tracked. */
	appendCoverage(entry: CoverageEntry): void;
	readCoverage(): CoverageEntry[];

	/** Append one cluster-naming run's usage (graph-global money channel) —
	 *  idempotent per startedAt. */

	/** Upsert one imported-notes source record (config.SOURCES_FILE — a
	 *  JSON map, not a ledger; an upsert keeps the existing usage log). */
	upsertSource(source: NotesSource): void;
	/** Every notes source record, by id order-insensitive. */
	readSources(): NotesSource[];
	/** Append one run's usage to a source record — idempotent per
	 *  startedAt, mirroring ChatRecord.extractions. */
	appendSourceUsage(id: string, entry: ExtractionRunUsage): void;

	/** The layout ledger (config.POSITIONS_FILE): nodeId → resting {x,y}.
	 *  WRITTEN ONLY by the incremental settle after a merge (core/layout.ts
	 *  settleGraphLayout) — read-only for everything else. */
	readPositions(): Record<string, Position>;
	/** Replace the whole ledger (the settle is a full-graph computation). */
	writePositions(positions: Record<string, Position>): void;

	/** Append one or more SourceEvidence records to the project's evidence ledger. */
	appendEvidence?(evidence: SourceEvidence | SourceEvidence[]): Promise<void>;
	/** Append a batch of SourceEvidence records to the project's evidence ledger. */
	appendEvidenceBatch?(evidenceList: SourceEvidence[]): Promise<void>;
	/** Query evidence records supporting a given proposition. */
	getEvidenceForProposition?(propositionId: string): Promise<SourceEvidence[]>;
	/** Query evidence records extracted from a given document. */
	getEvidenceForDocument?(documentId: DocumentId | string): Promise<SourceEvidence[]>;
	/** Query evidence records originating from a given source. */
	getEvidenceForSource?(sourceId: SourceId | string): Promise<SourceEvidence[]>;
	/** Read all evidence records in append order, optionally filtered by status. */
	readEvidence?(options?: { status?: "active" | "superseded" }): Promise<SourceEvidence[]>;
	/** Remove all evidence records associated with a document (optional seam). */
	removeEvidenceForDocument?(documentId: DocumentId | string): Promise<void>;

	/** THE DESTRUCTIVE SEAM (session-deletion wave 6, owner 2026-09-22 —
	 *  the first non-append operation on these ledgers): atomically
	 *  replace the full contents of any subset of the six rewritable
	 *  ledgers. Each provided array is written to a temp file and renamed
	 *  over the ledger (crash-safe: a torn write never replaces the
	 *  original); absent keys leave their ledger untouched. The pure
	 *  computation is core/graph-deletion.ts — the store only makes the
	 *  replacement atomic. */
	rewriteLedgers(next: {
		nodes?: GraphNode[];
		chains?: GraphChain[];
		coverage?: CoverageEntry[];
		checkpoints?: SessionCheckpoint[];
		evidence?: SourceEvidence[];
	}): void;
}


// ─── JobStore — background sub-agent jobs (data/jobs) ─────────────────────────

export interface CreateJobInit {
	kind: JobKind;
	chatId: string;
	toolCallId: string;
	/** First activity line (defaults to "starting"). */
	activity?: string;
	/** Saved on the job before its worker is spawned. */
	input?: unknown;
}

/** Mergeable fields — identity (id, kind, chatId, toolCallId, createdAt) is immutable. */
export type JobPatch = Partial<Omit<JobRecord, "id" | "kind" | "chatId" | "toolCallId" | "createdAt">>;

export interface JobStore {
	/** Create a running job (keyed by toolCallId for spawn dedup). */
	createJob(init: CreateJobInit): JobRecord;
	getJob(id: string): JobRecord | null;
	/** Merge a patch into the record; null if unknown id. */
	updateJob(id: string, patch: JobPatch): JobRecord | null;
	/** All jobs for a chat, newest activity first. */
	listJobs(chatId: string): JobRecord[];
	/** The job fulfilling a given tool part, if any (spawn-hook dedup). */
	findJobByToolCallId(chatId: string, toolCallId: string): JobRecord | null;
	/** Delete every job record for a chat — running or finished (session-
	 *  deletion wave 6). Returns how many files were removed. The deletion
	 *  route refuses while jobs are still running, so by the time this
	 *  fires every record is terminal. */
	deleteJobsForChat(chatId: string): number;
}

// ─── SettingsStore — THE user settings record (settings-storage wave, 2026-09-19) ──

/**
 * The one record for every non-secret product preference (core/settings.ts
 * UserSettings — delta semantics, see that module's doc). The store is
 * replace-whole on the RECORD; per-section scoping is a server-band concern
 * (single process, no stale-client hazard to defend against at this seam).
 * Schema-version lazy migration happens inside readSettings, never in
 * the callers. (The legacy default-settings.json fold died with the chat
 * section — per-session models, owner 2026-09-28.)
 */
export interface SettingsStore {
	/** The sanitized record, or null when none exists yet (first boot). */
	readSettings(): UserSettings | null;
	/** Persist the record (replace-whole). Callers pass a SANITIZED record. */
	writeSettings(settings: UserSettings): void;
}

// ─── PromptOverrideStore — per-segment system-prompt overrides (2026-09-19) ──

/**
 * User text overriding ONE source prompt segment (the shared base or one
 * numeric fragment), stored at the data-dir seam mirroring the source
 * layout (config.PROMPTS_OVERRIDE_DIR). File presence is NOT the override:
 * the settings record's agent.prompts switch is the explicit on/off, so a
 * user can keep a customized file on disk while running the source default.
 * The segment LIST is always derived from source at runtime — see the
 * adapter (src/store/prompt-overrides.ts) for the loader rules.
 */
export interface PromptOverrideStore {
	/** Every override path currently on disk ("system-prompt.md",
	 *  "teacher/20-teaching.md", ...), POSIX-relative, sorted. */
	listOverrides(): string[];
	/** The override text, or null when the path has no file. */
	readOverride(segmentPath: string): string | null;
	/** Persist override text for a segment path (creates parents). */
	writeOverride(segmentPath: string, text: string): void;
	/** Remove the override file, if present (switches are untouched — an
	 *  on-switch with no file composes the source default, inert). */
	deleteOverride(segmentPath: string): void;
}

// ─── AuthStore — BYOK provider keys (auth-keys wave, 2026-09-19) ────────────

/**
 * The long-standing flat {VAR: value} auth.json map (config.AUTH_FILE) —
 * the same file the Electron app has always hand-edited, now first-class
 * server-managed. Values are opaque strings: shape validation is a
 * server-band concern (core/auth-keys.ts validateKeyShape — the store
 * persists what it is given); env precedence is a server-band concern
 * too (src/server/keys.ts). Unknown vars ride along verbatim.
 */
export interface AuthStore {
	/** The whole map — absent or corrupt file = {} ("no keys yet", the
	 *  documented first-boot state). Never throws. */
	authVars(): Record<string, string>;
	/** Set one VAR (atomic write, mode 0600 always, other vars preserved). */
	setAuthVar(name: string, value: string): void;
	/** Remove one VAR if present (absent = no-op, still a silent success). */
	deleteAuthVar(name: string): void;
}


// ─── LocalAgentPreferenceStore — local agent connections (§8.2) ─────────────

/**
 * The learner's per-connection choices for locally installed agent
 * runtimes (enabled, background use) — the ONLY state LearnHarness keeps
 * for them; the runtimes own their sign-in. Absent or corrupt file = no
 * choices yet (every connection off). Never throws on read.
 */
export interface LocalAgentPreferenceStore {
	read(): Partial<Record<LocalAgentProviderId, LocalAgentPreferences>>;
	write(providerId: LocalAgentProviderId, preferences: LocalAgentPreferences): void;
}

// ─── ProjectStore — global projects registry & project metadata ─────────────

export type ProjectPatch = Partial<Omit<Project, "id" | "createdAt" | "settings">> & {
	settings?: Partial<ProjectSettings>;
};

export interface ProjectStore {
	readonly dataDir?: string;
	listProjects(): Promise<Project[]>;
	getProject(id: ProjectId): Promise<Project | null>;
	createProject(input: {
		name: string;
		description?: string;
		settings?: Partial<Project["settings"]>;
		id?: ProjectId;
	}): Promise<Project>;
	updateProject(id: ProjectId, patch: ProjectPatch): Promise<Project>;
	archiveProject(id: ProjectId): Promise<void>;
	deleteProject(id: ProjectId): Promise<boolean>;
	getActiveProjectId(): Promise<ProjectId | null>;
	setActiveProjectId(id: ProjectId): Promise<void>;
}

// ─── VaultRegistry — globally registered Obsidian vaults across devices ───────

export interface VaultRegistry {
	readonly dataDir?: string;
	listVaults(): Promise<Vault[]>;
	getVault(id: VaultId): Promise<Vault | null>;
	registerVault(vault: Omit<Vault, "id"> & { id?: VaultId }): Promise<Vault>;
	updateBinding(vaultId: VaultId, binding: VaultBinding): Promise<Vault>;
	updateVault(
		id: VaultId,
		patch: { displayName?: string; bindings?: VaultBinding[] },
	): Promise<Vault>;
	deleteVault(id: VaultId): Promise<boolean>;
	checkVaultAvailability?(id: VaultId): Promise<Vault | null>;
	checkAllVaultsAvailability?(): Promise<Vault[]>;
}

// ─── SourceStore — project-scoped attached sources and documents ─────────────

export interface SourceStore {
	listSources(projectId: ProjectId): Promise<ProjectSource[]>;
	getSource(id: SourceId): Promise<ProjectSource | null>;
	addSource(source: {
		projectId: ProjectId;
		vaultId: VaultId;
		include?: string[];
		exclude?: string[];
		recursive?: boolean;
		enabled?: boolean;
		syncMode?: "manual" | "automatic";
		deletionPolicy?: "deactivate" | "retain";
		id?: SourceId;
	}): Promise<ProjectSource>;
	updateSource(id: SourceId, patch: Partial<Omit<ProjectSource, "id" | "projectId" | "createdAt">>): Promise<ProjectSource>;
	removeSource(id: SourceId): Promise<void>;
	listDocuments(sourceId: SourceId): Promise<SourceDocument[]>;
	upsertDocument(doc: SourceDocument): Promise<void>;
	upsertDocuments?(docs: SourceDocument[]): Promise<void>;
}

// ─── PracticeStore & ProblemSet — problem sets and problem snapshots ─────────

export interface ProblemSet {
	id: string;
	projectId: ProjectId;
	title: string;
	createdAt: string;
	updatedAt: string;
	nodeIds: string[];
	propositions: Record<string, { name: string; statement: string }>;
	chains: GraphChain[];
	status: "active" | "completed" | "archived";
}

export interface PracticeStore {
	createProblemSet(init: {
		projectId: ProjectId;
		title: string;
		nodeIds: string[];
		propositions: Record<string, { name: string; statement: string }>;
		chains: GraphChain[];
	}): Promise<ProblemSet>;
	getProblemSet(id: string): Promise<ProblemSet | null>;
	listProblemSets(projectId?: ProjectId): Promise<ProblemSet[]>;
	updateProblemSet(id: string, patch: Partial<ProblemSet>): Promise<ProblemSet | null>;
	deleteProblemSet(id: string): Promise<boolean>;
}

