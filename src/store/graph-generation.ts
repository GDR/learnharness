/**
 * Graph Generation Transaction Manager & Crash Recovery Engine.
 *
 * Implements monotonic generation tracking, staging area validation,
 * zero orphan evidence invariants, snapshot backup, atomic swap, and
 * crash recovery for Milestone C Slice 6.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { writeAtomicFileSync, writeAtomicJsonSync } from "../core/fs-atomic.ts";
import { getProjectAuditLock, validateProjectId } from "../core/audit-lock.ts";
import type {
	ProjectGenerationRecord,
	CommitJournalRecord,
	CommitGenerationParams,
	CommitGenerationResult,
	LedgerSnapshot,
	RecoveryReport,
} from "../core/contracts/generation.ts";
import {
	projectGenerationRecordSchema,
	commitJournalRecordSchema,
	CommitInvariantError,
	GenerationConflictError,
} from "../core/contracts/generation.ts";
import type { GraphNode, GraphChain } from "../core/contracts/graph.ts";
import type { SourceEvidence } from "../core/contracts/evidence.ts";
import {
	sourceEvidenceSchema,
	computeEvidenceDedupKey,
	validateSourceEvidence,
} from "../core/contracts/evidence.ts";

const EMPTY_BUFFER_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/**
 * Computes lineCount, byteOffset, and SHA256 checksum of a ledger file.
 */
export function computeLedgerSnapshot(filePath: string): LedgerSnapshot {
	if (!fs.existsSync(filePath)) {
		return {
			byteOffset: 0,
			lineCount: 0,
			sha256: EMPTY_BUFFER_SHA256,
		};
	}
	const buffer = fs.readFileSync(filePath);
	const byteOffset = buffer.length;
	const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
	const text = buffer.toString("utf-8");
	const lineCount = text.split("\n").filter((l) => l.trim().length > 0).length;
	return {
		byteOffset,
		lineCount,
		sha256,
	};
}

/**
 * Computes SHA256 of file buffer on disk.
 */
export function computeFileSha256(filePath: string): string {
	if (!fs.existsSync(filePath)) {
		return EMPTY_BUFFER_SHA256;
	}
	const buffer = fs.readFileSync(filePath);
	return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * Derives project ID from directory structure if generation.json is absent.
 */
export function resolveProjectIdFromGraphDir(graphDir: string): string {
	const genFile = path.join(graphDir, "generation.json");
	if (fs.existsSync(genFile)) {
		try {
			const raw = JSON.parse(fs.readFileSync(genFile, "utf-8"));
			if (typeof raw?.projectId === "string" && raw.projectId.trim()) {
				return raw.projectId.trim();
			}
		} catch {
			// ignore corrupt generation file
		}
	}
	const normalized = path.resolve(graphDir);
	const match = normalized.match(/projects[/\\]([^/\\]+)[/\\]graph/);
	if (match?.[1]) {
		return match[1];
	}
	const parent = path.basename(path.dirname(normalized));
	if (parent && parent !== "." && parent !== "data") {
		try {
			return validateProjectId(parent);
		} catch {
			// fallback
		}
	}
	return "default";
}

/**
 * Reads and validates generation.json, returning null if missing or invalid.
 */
export function readGenerationRecord(genFile: string): ProjectGenerationRecord | null {
	if (!fs.existsSync(genFile)) return null;
	try {
		const raw = JSON.parse(fs.readFileSync(genFile, "utf-8"));
		const parsed = projectGenerationRecordSchema.safeParse(raw);
		if (!parsed.success) return null;

		const record = parsed.data as ProjectGenerationRecord;
		// Ensure counts & checksums are populated
		record.checksums = {
			nodesSha256: record.snapshots.nodes.sha256,
			evidenceSha256: record.snapshots.evidence.sha256,
		};
		record.counts = {
			nodeCount: record.snapshots.nodes.lineCount,
			evidenceCount: record.snapshots.evidence.lineCount,
		};
		return record;
	} catch {
		return null;
	}
}

/**
 * Writes generation.json atomically with 2-space indentation.
 */
export function writeGenerationRecord(genFile: string, record: ProjectGenerationRecord): void {
	const content = JSON.stringify(record, null, 2) + "\n";
	writeAtomicFileSync(genFile, content, { encoding: "utf8" });
}

/**
 * Initializes generation 0 baseline for a new or existing un-versioned graph store.
 */
export function initializeBaselineGeneration(
	graphDir: string,
	projectId?: string,
): ProjectGenerationRecord {
	const targetProjectId = validateProjectId(projectId ?? resolveProjectIdFromGraphDir(graphDir));
	fs.mkdirSync(graphDir, { recursive: true });

	const nodesFile = path.join(graphDir, "nodes.jsonl");
	const evidenceFile = path.join(graphDir, "evidence.jsonl");
	const genFile = path.join(graphDir, "generation.json");

	const nodesSnap = computeLedgerSnapshot(nodesFile);
	const evidenceSnap = computeLedgerSnapshot(evidenceFile);

	const gen0: ProjectGenerationRecord = {
		projectId: targetProjectId,
		generation: 0,
		committedAt: new Date().toISOString(),
		commitId: "gen-0-init",
		status: "committed",
		snapshots: {
			nodes: nodesSnap,
			evidence: evidenceSnap,
		},
		checksums: {
			nodesSha256: nodesSnap.sha256,
			evidenceSha256: evidenceSnap.sha256,
		},
		counts: {
			nodeCount: nodesSnap.lineCount,
			evidenceCount: evidenceSnap.lineCount,
		},
	};

	writeGenerationRecord(genFile, gen0);

	// Persist baseline snapshot in .snapshots/gen-0/
	const snapshotDir = path.join(graphDir, ".snapshots", "gen-0");
	try {
		fs.mkdirSync(snapshotDir, { recursive: true });
		writeGenerationRecord(path.join(snapshotDir, "generation.json"), gen0);
		if (fs.existsSync(nodesFile)) {
			fs.copyFileSync(nodesFile, path.join(snapshotDir, "nodes.jsonl"));
		}
		if (fs.existsSync(evidenceFile)) {
			fs.copyFileSync(evidenceFile, path.join(snapshotDir, "evidence.jsonl"));
		}
	} catch {
		// Non-fatal snapshot error
	}

	return gen0;
}

/**
 * Retrieves authoritative project generation record, initializing baseline if absent.
 */
export async function getProjectGeneration(
	graphDir: string,
	projectId?: string,
): Promise<ProjectGenerationRecord> {
	const genFile = path.join(graphDir, "generation.json");
	const existing = readGenerationRecord(genFile);
	if (existing) return existing;
	return initializeBaselineGeneration(graphDir, projectId);
}

function isValidGraphNode(node: unknown): node is GraphNode {
	if (typeof node !== "object" || node === null) return false;
	const n = node as Record<string, unknown>;
	return (
		typeof n.id === "string" &&
		n.id.trim().length > 0 &&
		typeof n.name === "string" &&
		typeof n.statement === "string" &&
		n.statement.trim().length > 0 &&
		Array.isArray(n.aliases) &&
		n.aliases.every((a) => typeof a === "string") &&
		Array.isArray(n.provenance) &&
		typeof n.createdAt === "string"
	);
}

/**
 * Validates pre-commit invariants across candidate additions and existing graph state:
 * 1. Node schema compliance & non-empty identifiers.
 * 2. SourceEvidence schema compliance.
 * 3. Zero orphan evidence: all active evidence must reference an existing proposition.
 * 4. Zero duplicate active evidence conflicting in dedup keys.
 */
export function validatePreCommitInvariants(params: {
	nodesToAppend: GraphNode[];
	evidenceBatch: SourceEvidence[];
	existingNodeIds: Set<string>;
}): void {
	const { nodesToAppend, evidenceBatch, existingNodeIds } = params;

	// 1. Validate nodes
	const candidateNodeIds = new Set<string>(existingNodeIds);
	for (const node of nodesToAppend) {
		if (!isValidGraphNode(node)) {
			throw new CommitInvariantError(
				"Invalid GraphNode schema: missing required fields or empty id/statement",
				{ node },
			);
		}
		// Check JSON serializability without illegal control characters
		try {
			const str = JSON.stringify(node);
			JSON.parse(str);
		} catch (err) {
			throw new CommitInvariantError("GraphNode failed JSON round-trip serialization", {
				error: String(err),
				node,
			});
		}
		candidateNodeIds.add(node.id);
	}

	// 2. Validate evidence
	const activeDedupKeys = new Set<string>();
	for (const ev of evidenceBatch) {
		const parsed = sourceEvidenceSchema.safeParse(ev);
		if (!parsed.success) {
			throw new CommitInvariantError("Invalid SourceEvidence schema", {
				issues: parsed.error.issues,
				evidence: ev,
			});
		}

		try {
			const str = JSON.stringify(ev);
			JSON.parse(str);
		} catch (err) {
			throw new CommitInvariantError("SourceEvidence failed JSON round-trip serialization", {
				error: String(err),
				evidence: ev,
			});
		}

		// 3. Zero orphan evidence invariant
		if (ev.status === "active") {
			if (!candidateNodeIds.has(ev.propositionId)) {
				throw new CommitInvariantError(
					`Active evidence references non-existent proposition "${ev.propositionId}"`,
					{ orphanPropositionId: ev.propositionId, evidenceId: ev.id },
				);
			}

			// 4. Duplicate active key detection within the candidate batch
			const dedupKey = computeEvidenceDedupKey(ev);
			if (activeDedupKeys.has(dedupKey)) {
				throw new CommitInvariantError(
					`Conflicting duplicate active evidence with dedup key "${dedupKey}" in commit batch`,
					{ dedupKey, evidenceId: ev.id },
				);
			}
			activeDedupKeys.add(dedupKey);
		}
	}
}

/**
 * Reads existing proposition IDs from nodes.jsonl.
 */
function readExistingNodeIds(nodesFile: string): Set<string> {
	const ids = new Set<string>();
	if (!fs.existsSync(nodesFile)) return ids;
	try {
		const lines = fs.readFileSync(nodesFile, "utf-8").split("\n");
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const obj = JSON.parse(trimmed);
				if (typeof obj?.id === "string") {
					ids.add(obj.id);
				}
			} catch {
				// Corrupt lines ignored during id scan
			}
		}
	} catch {
		// Ignore read error
	}
	return ids;
}

/**
 * Stages candidate changes into .staging/gen-<targetGen>/ and executes atomic swap.
 */
export async function executeGenerationCommit(
	graphDir: string,
	params: CommitGenerationParams,
): Promise<CommitGenerationResult> {
	const startTime = Date.now();
	const projectId = validateProjectId(params.projectId ?? resolveProjectIdFromGraphDir(graphDir));
	const lock = getProjectAuditLock(projectId);

	return lock(async () => {
		const genFile = path.join(graphDir, "generation.json");
		const currentRecord = await getProjectGeneration(graphDir, projectId);

		// Optimistic concurrency check (Scenario E)
		if (params.baseGeneration !== undefined && params.baseGeneration !== currentRecord.generation) {
			throw new GenerationConflictError(
				params.baseGeneration,
				currentRecord.generation,
				projectId,
			);
		}

		const targetGeneration = currentRecord.generation + 1;
		const commitId = `commit-${targetGeneration}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
		const nodesFile = path.join(graphDir, "nodes.jsonl");
		const evidenceFile = path.join(graphDir, "evidence.jsonl");

		const nodesToAppend = params.nodesToAppend ?? [];
		const evidenceBatch = params.evidenceBatch ?? [];
		// Note: chainsToAppend is declared in CommitGenerationParams contract for multi-ledger sessions;
		// Milestone C atomic reconciliation operates strictly on nodes and evidence ledgers.

		// Read existing node IDs
		const existingNodeIds = readExistingNodeIds(nodesFile);

		// Pre-commit Invariant Validation
		validatePreCommitInvariants({
			nodesToAppend,
			evidenceBatch,
			existingNodeIds,
		});

		// Staging directory setup
		const stagingDir = path.join(graphDir, ".staging");
		const genStagingDir = path.join(stagingDir, `gen-${targetGeneration}`);
		const backupDir = path.join(stagingDir, `backup-gen-${currentRecord.generation}`);
		const journalFile = path.join(stagingDir, "journal.json");

		// Clean up any stale staging
		if (fs.existsSync(stagingDir)) {
			fs.rmSync(stagingDir, { recursive: true, force: true });
		}
		fs.mkdirSync(genStagingDir, { recursive: true });
		fs.mkdirSync(backupDir, { recursive: true });

		const stagedNodesFile = path.join(genStagingDir, "nodes.jsonl");
		const stagedEvidenceFile = path.join(genStagingDir, "evidence.jsonl");

		try {
			// Write staged nodes
			const existingNodesContent = fs.existsSync(nodesFile) ? fs.readFileSync(nodesFile, "utf-8") : "";
			const nodesPrefix = existingNodesContent.length > 0 && !existingNodesContent.endsWith("\n")
				? existingNodesContent + "\n"
				: existingNodesContent;
			const newNodesContent = nodesToAppend.map((n) => JSON.stringify(n)).join("\n");
			const candidateNodesBody =
				nodesPrefix + (newNodesContent ? newNodesContent + "\n" : "");
			fs.writeFileSync(stagedNodesFile, candidateNodesBody, "utf-8");

			// Write staged evidence
			const existingEvidenceContent = fs.existsSync(evidenceFile)
				? fs.readFileSync(evidenceFile, "utf-8")
				: "";
			const evidencePrefix =
				existingEvidenceContent.length > 0 && !existingEvidenceContent.endsWith("\n")
					? existingEvidenceContent + "\n"
					: existingEvidenceContent;
			const newEvidenceContent = evidenceBatch.map((e) => JSON.stringify(e)).join("\n");
			const candidateEvidenceBody =
				evidencePrefix + (newEvidenceContent ? newEvidenceContent + "\n" : "");
			fs.writeFileSync(stagedEvidenceFile, candidateEvidenceBody, "utf-8");

			// Physical JSON line syntax verification on staged files
			for (const line of candidateNodesBody.split("\n")) {
				if (!line.trim()) continue;
				try {
					JSON.parse(line);
				} catch {
					throw new CommitInvariantError("Malformed JSON line in candidate nodes.jsonl");
				}
			}
			for (const line of candidateEvidenceBody.split("\n")) {
				if (!line.trim()) continue;
				try {
					JSON.parse(line);
				} catch {
					throw new CommitInvariantError("Malformed JSON line in candidate evidence.jsonl");
				}
			}

			// Compute candidate snapshots
			const candidateNodesSnap = computeLedgerSnapshot(stagedNodesFile);
			const candidateEvidenceSnap = computeLedgerSnapshot(stagedEvidenceFile);

			// Backup canonical files
			if (fs.existsSync(nodesFile)) {
				fs.copyFileSync(nodesFile, path.join(backupDir, "nodes.jsonl"));
			}
			if (fs.existsSync(evidenceFile)) {
				fs.copyFileSync(evidenceFile, path.join(backupDir, "evidence.jsonl"));
			}

			// Write journal
			const journal: CommitJournalRecord = {
				projectId,
				targetGeneration,
				previousGeneration: currentRecord.generation,
				stagedGeneration: targetGeneration,
				commitId,
				stage: "swapping",
				status: "staged",
				startedAt: new Date().toISOString(),
				timestamp: new Date().toISOString(),
				stagingDir: genStagingDir,
				backupDir,
				stagedFiles: {
					nodes: stagedNodesFile,
					evidence: stagedEvidenceFile,
				},
			};
			writeAtomicJsonSync(journalFile, journal);

			// Atomic file swap
			fs.renameSync(stagedNodesFile, nodesFile);
			fs.renameSync(stagedEvidenceFile, evidenceFile);

			// Authoritative next generation record
			const committedAt = new Date().toISOString();
			const nextRecord: ProjectGenerationRecord = {
				projectId,
				generation: targetGeneration,
				committedAt,
				commitId,
				sourceId: params.sourceId,
				documentId: params.documentId,
				jobId: params.jobId,
				status: "committed",
				snapshots: {
					nodes: candidateNodesSnap,
					evidence: candidateEvidenceSnap,
				},
				checksums: {
					nodesSha256: candidateNodesSnap.sha256,
					evidenceSha256: candidateEvidenceSnap.sha256,
				},
				counts: {
					nodeCount: candidateNodesSnap.lineCount,
					evidenceCount: candidateEvidenceSnap.lineCount,
				},
			};

			// Write generation.json atomically [THE COMMIT POINT]
			writeGenerationRecord(genFile, nextRecord);

			// Persist historical snapshot for fast, byte-exact rollback
			const snapshotDir = path.join(graphDir, ".snapshots", `gen-${targetGeneration}`);
			try {
				fs.mkdirSync(snapshotDir, { recursive: true });
				writeGenerationRecord(path.join(snapshotDir, "generation.json"), nextRecord);
				if (fs.existsSync(nodesFile)) {
					fs.copyFileSync(nodesFile, path.join(snapshotDir, "nodes.jsonl"));
				}
				if (fs.existsSync(evidenceFile)) {
					fs.copyFileSync(evidenceFile, path.join(snapshotDir, "evidence.jsonl"));
				}
			} catch {
				// Non-fatal
			}

			// Clean up staging
			if (fs.existsSync(stagingDir)) {
				fs.rmSync(stagingDir, { recursive: true, force: true });
			}

			return {
				projectId,
				generation: targetGeneration,
				previousGeneration: currentRecord.generation,
				commitId,
				committedAt,
				stats: {
					nodesAppended: nodesToAppend.length,
					evidenceAppended: evidenceBatch.length,
					chainsAppended: 0,
					durationMs: Date.now() - startTime,
				},
				snapshots: nextRecord.snapshots,
				checksums: nextRecord.checksums,
				counts: nextRecord.counts,
			};
		} catch (err) {
			// On error, purge staging directory to avoid leaving broken files
			if (fs.existsSync(stagingDir)) {
				fs.rmSync(stagingDir, { recursive: true, force: true });
			}
			throw err;
		}
	});
}

/**
 * Checks whether uncommitted bytes appended beyond committedOffset contain a torn line.
 * A torn append is characterized by a missing trailing newline or any corrupt/incomplete line in the tail.
 */
export function hasTornTail(filePath: string, committedOffset: number): boolean {
	const buffer = fs.readFileSync(filePath);
	if (buffer.length <= committedOffset) return false;
	// Incomplete write: lacks trailing newline delimiter
	if (buffer[buffer.length - 1] !== 0x0a) return true;
	const tail = buffer.subarray(committedOffset).toString("utf-8");
	const lines = tail.split("\n").filter((l) => l.trim().length > 0);
	if (lines.length === 0) return false;
	for (const line of lines) {
		try {
			JSON.parse(line);
		} catch {
			return true;
		}
	}
	return false;
}

/**
 * Restores canonical files from a backup directory.
 */
function restoreFromBackup(graphDir: string, backupDir: string): void {
	if (!fs.existsSync(backupDir)) return;
	const nodesBackup = path.join(backupDir, "nodes.jsonl");
	const evidenceBackup = path.join(backupDir, "evidence.jsonl");

	if (fs.existsSync(nodesBackup)) {
		fs.copyFileSync(nodesBackup, path.join(graphDir, "nodes.jsonl"));
	}
	if (fs.existsSync(evidenceBackup)) {
		fs.copyFileSync(evidenceBackup, path.join(graphDir, "evidence.jsonl"));
	}
}

/**
 * Recovers graph store consistency after an ungraceful shutdown or crash.
 * Invoked automatically on GraphStore boot or explicitly via recoverConsistency().
 */
export async function recoverGraphStore(graphDir: string): Promise<RecoveryReport> {
	const genFile = path.join(graphDir, "generation.json");
	const stagingDir = path.join(graphDir, ".staging");
	const journalFile = path.join(stagingDir, "journal.json");

	// 1. If generation.json is missing, initialize baseline generation 0
	if (!fs.existsSync(genFile)) {
		const gen0 = initializeBaselineGeneration(graphDir);
		return { action: "initialized", generation: 0, details: { projectId: gen0.projectId } };
	}

	const currentGen = readGenerationRecord(genFile);
	if (!currentGen) {
		const gen0 = initializeBaselineGeneration(graphDir);
		return { action: "initialized", generation: 0, details: { error: "Corrupted generation.json reset" } };
	}

	// 2. Check for in-flight uncommitted journal
	if (fs.existsSync(journalFile)) {
		try {
			const journal = JSON.parse(fs.readFileSync(journalFile, "utf-8")) as CommitJournalRecord;
			if (journal.stage !== "committed") {
				if (currentGen && currentGen.generation >= journal.targetGeneration) {
					// The authoritative commit point (writing generation.json) succeeded before crash.
					// Do NOT restore from backup! Simply purge leftover staging directory.
					fs.rmSync(stagingDir, { recursive: true, force: true });
				} else {
					// Commit point was not reached; restore from backup and purge staging.
					if (fs.existsSync(journal.backupDir)) {
						restoreFromBackup(graphDir, journal.backupDir);
					}
					fs.rmSync(stagingDir, { recursive: true, force: true });
					return {
						action: "rolled_back",
						generation: journal.previousGeneration,
						details: { rolledBackFrom: journal.targetGeneration, commitId: journal.commitId },
					};
				}
			}
		} catch {
			// Corrupt journal
		}
	}

	// 3. Inspect canonical file lengths and checksums against generation.json
	const nodesFile = path.join(graphDir, "nodes.jsonl");
	const evidenceFile = path.join(graphDir, "evidence.jsonl");
	let repaired = false;

	if (fs.existsSync(nodesFile)) {
		const stat = fs.statSync(nodesFile);
		if (stat.size > currentGen.snapshots.nodes.byteOffset) {
			if (hasTornTail(nodesFile, currentGen.snapshots.nodes.byteOffset)) {
				fs.truncateSync(nodesFile, currentGen.snapshots.nodes.byteOffset);
				repaired = true;
			} else {
				currentGen.snapshots.nodes = computeLedgerSnapshot(nodesFile);
				writeGenerationRecord(genFile, currentGen);
			}
		} else if (computeFileSha256(nodesFile) !== currentGen.snapshots.nodes.sha256) {
			// Check if we have snapshot backup
			const snapDir = path.join(graphDir, ".snapshots", `gen-${currentGen.generation}`);
			const snapNodes = path.join(snapDir, "nodes.jsonl");
			if (fs.existsSync(snapNodes)) {
				fs.copyFileSync(snapNodes, nodesFile);
				repaired = true;
			}
		}
	}

	if (fs.existsSync(evidenceFile)) {
		const stat = fs.statSync(evidenceFile);
		if (stat.size > currentGen.snapshots.evidence.byteOffset) {
			if (hasTornTail(evidenceFile, currentGen.snapshots.evidence.byteOffset)) {
				fs.truncateSync(evidenceFile, currentGen.snapshots.evidence.byteOffset);
				repaired = true;
			} else {
				currentGen.snapshots.evidence = computeLedgerSnapshot(evidenceFile);
				writeGenerationRecord(genFile, currentGen);
			}
		} else if (computeFileSha256(evidenceFile) !== currentGen.snapshots.evidence.sha256) {
			const snapDir = path.join(graphDir, ".snapshots", `gen-${currentGen.generation}`);
			const snapEvidence = path.join(snapDir, "evidence.jsonl");
			if (fs.existsSync(snapEvidence)) {
				fs.copyFileSync(snapEvidence, evidenceFile);
				repaired = true;
			}
		}
	}

	// 4. Clean up any leftover staging directories
	if (fs.existsSync(stagingDir)) {
		fs.rmSync(stagingDir, { recursive: true, force: true });
	}

	if (repaired) {
		return { action: "repaired", generation: currentGen.generation };
	}

	return { action: "verified", generation: currentGen.generation };
}

/**
 * Explicit programmatic rollback to a previous generation (or generation - 1).
 * Protected under project audit lock to guarantee serialization with concurrent commits.
 */
export async function rollbackGraphGeneration(
	graphDir: string,
	targetGeneration?: number,
): Promise<ProjectGenerationRecord> {
	let projectId: string;
	try {
		projectId = validateProjectId(resolveProjectIdFromGraphDir(graphDir));
	} catch {
		projectId = "default";
	}
	const lock = getProjectAuditLock(projectId);

	return lock(async () => {
		const currentGen = await getProjectGeneration(graphDir, projectId);
		const targetGen = targetGeneration !== undefined ? targetGeneration : currentGen.generation - 1;

		if (targetGen < 0) {
			throw new Error(`Cannot rollback to negative generation ${targetGen}`);
		}

		const snapshotDir = path.join(graphDir, ".snapshots", `gen-${targetGen}`);
		const targetGenFile = path.join(snapshotDir, "generation.json");

		if (!fs.existsSync(targetGenFile)) {
			throw new Error(
				`Cannot rollback to generation ${targetGen}: snapshot not found at ${snapshotDir}`,
			);
		}

		const restoredRecord = readGenerationRecord(targetGenFile);
		if (!restoredRecord) {
			throw new Error(`Corrupted generation record at ${targetGenFile}`);
		}

		const nodesBackup = path.join(snapshotDir, "nodes.jsonl");
		const evidenceBackup = path.join(snapshotDir, "evidence.jsonl");
		const canonicalNodes = path.join(graphDir, "nodes.jsonl");
		const canonicalEvidence = path.join(graphDir, "evidence.jsonl");

		if (fs.existsSync(nodesBackup)) {
			fs.copyFileSync(nodesBackup, canonicalNodes);
		} else if (fs.existsSync(canonicalNodes)) {
			fs.truncateSync(canonicalNodes, 0);
		}

		if (fs.existsSync(evidenceBackup)) {
			fs.copyFileSync(evidenceBackup, canonicalEvidence);
		} else if (fs.existsSync(canonicalEvidence)) {
			fs.truncateSync(canonicalEvidence, 0);
		}

		writeGenerationRecord(path.join(graphDir, "generation.json"), restoredRecord);

		return restoredRecord;
	});
}

/**
 * Synchronous version of recoverGraphStore for store boot.
 */
export function recoverGraphStoreSync(graphDir: string): RecoveryReport {
	const genFile = path.join(graphDir, "generation.json");
	const stagingDir = path.join(graphDir, ".staging");
	const journalFile = path.join(stagingDir, "journal.json");

	if (!fs.existsSync(genFile)) {
		const gen0 = initializeBaselineGeneration(graphDir);
		return { action: "initialized", generation: 0, details: { projectId: gen0.projectId } };
	}

	const currentGen = readGenerationRecord(genFile);
	if (!currentGen) {
		const gen0 = initializeBaselineGeneration(graphDir);
		return { action: "initialized", generation: 0, details: { error: "Corrupted generation.json reset" } };
	}

	if (fs.existsSync(journalFile)) {
		try {
			const journal = JSON.parse(fs.readFileSync(journalFile, "utf-8")) as CommitJournalRecord;
			if (journal.stage !== "committed") {
				if (currentGen && currentGen.generation >= journal.targetGeneration) {
					// The authoritative commit point (writing generation.json) succeeded before crash.
					// Do NOT restore from backup! Simply purge leftover staging directory.
					fs.rmSync(stagingDir, { recursive: true, force: true });
				} else {
					// Commit point was not reached; restore from backup and purge staging.
					if (fs.existsSync(journal.backupDir)) {
						restoreFromBackup(graphDir, journal.backupDir);
					}
					fs.rmSync(stagingDir, { recursive: true, force: true });
					return {
						action: "rolled_back",
						generation: journal.previousGeneration,
						details: { rolledBackFrom: journal.targetGeneration, commitId: journal.commitId },
					};
				}
			}
		} catch {
			// Corrupt journal
		}
	}

	const nodesFile = path.join(graphDir, "nodes.jsonl");
	const evidenceFile = path.join(graphDir, "evidence.jsonl");
	let repaired = false;

	if (fs.existsSync(nodesFile)) {
		const stat = fs.statSync(nodesFile);
		if (stat.size > currentGen.snapshots.nodes.byteOffset) {
			if (hasTornTail(nodesFile, currentGen.snapshots.nodes.byteOffset)) {
				fs.truncateSync(nodesFile, currentGen.snapshots.nodes.byteOffset);
				repaired = true;
			} else {
				currentGen.snapshots.nodes = computeLedgerSnapshot(nodesFile);
				writeGenerationRecord(genFile, currentGen);
			}
		} else if (computeFileSha256(nodesFile) !== currentGen.snapshots.nodes.sha256) {
			const snapDir = path.join(graphDir, ".snapshots", `gen-${currentGen.generation}`);
			const snapNodes = path.join(snapDir, "nodes.jsonl");
			if (fs.existsSync(snapNodes)) {
				fs.copyFileSync(snapNodes, nodesFile);
				repaired = true;
			}
		}
	}

	if (fs.existsSync(evidenceFile)) {
		const stat = fs.statSync(evidenceFile);
		if (stat.size > currentGen.snapshots.evidence.byteOffset) {
			if (hasTornTail(evidenceFile, currentGen.snapshots.evidence.byteOffset)) {
				fs.truncateSync(evidenceFile, currentGen.snapshots.evidence.byteOffset);
				repaired = true;
			} else {
				currentGen.snapshots.evidence = computeLedgerSnapshot(evidenceFile);
				writeGenerationRecord(genFile, currentGen);
			}
		} else if (computeFileSha256(evidenceFile) !== currentGen.snapshots.evidence.sha256) {
			const snapDir = path.join(graphDir, ".snapshots", `gen-${currentGen.generation}`);
			const snapEvidence = path.join(snapDir, "evidence.jsonl");
			if (fs.existsSync(snapEvidence)) {
				fs.copyFileSync(snapEvidence, evidenceFile);
				repaired = true;
			}
		}
	}

	if (fs.existsSync(stagingDir)) {
		fs.rmSync(stagingDir, { recursive: true, force: true });
	}

	if (repaired) {
		return { action: "repaired", generation: currentGen.generation };
	}

	return { action: "verified", generation: currentGen.generation };
}

export const recoverGraphGeneration = recoverGraphStore;
export const recoverGraphGenerationSync = recoverGraphStoreSync;
export const rollbackGeneration = rollbackGraphGeneration;
