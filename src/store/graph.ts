/**
 * GraphStore — the fs JSONL adapter: the append-only ledgers at
 * config.LEDGER_FILES or project-scoped data/projects/<id>/graph/ (contracts.ts "v1 emission").
 *   nodes.jsonl     GraphNode        — one line per node write: the FIRST
 *                                      line for an id defines it; a later
 *                                      line with a REPEATED id is a
 *                                      link-append (session phrasings join
 *                                      aliases, provenance unions); reads
 *                                      merge by id (core/graph.ts getGraph)
 *   chains.jsonl    GraphChain       — one line per chain ASSERTION (a second
 *                                      session asserting the same
 *                                      (premises, conclusion) appends
 *                                      another line; readers merge)
 *   sessions.jsonl  SessionCheckpoint— emission checkpoints (foldedAt)
 *   coverage.jsonl  CoverageEntry    — per-message extraction coverage
 *
 * CHAINS-PRIMARY (owner, 2026-09-30): there is NO edges ledger — the edge
 * view (implication nodes + untyped arrows) is derived in core/graph.ts on
 * every read and never persisted. A stale edges.jsonl left by a pre-chains
 * build is deleted once, here, at adapter load (same doctrine as the
 * events-ledger purge below).
 *
 * Plus config.SOURCES_FILE (sources.json): the imported-notes bookkeeping
 * (NOT a ledger) — one JSON map, src-id → NotesSource, read-modify-write
 * like a chat file. The format-agnostic front door (2026-09-13).
 *
 * Implements core/ports.ts GraphStore. data/graph/* or project-scoped is exclusively
 * this adapter's. Reads are strict against the contracts.ts shapes (the 2026-09-02
 * graph redesign): corrupt lines are skipped, never guessed at — the ledgers
 * are the source of truth and everything else is derived (core/graph.ts,
 * which takes this port as a parameter).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { assertGraphFormat, ensureGraphFormat } from "./graph-format.ts";
import { writeAtomicFileSync, writeAtomicJsonSync } from "../core/fs-atomic.ts";
import type {
	GraphChain,
	GraphNode,
	ExtractionRunUsage,
	NotesSource,
	Position,
	ProvenancePoint,
	CoverageEntry,
	SessionCheckpoint,
} from "../core/contracts.ts";
import type { SourceEvidence } from "../core/contracts/evidence.ts";
import {
	sourceEvidenceSchema,
	computeEvidenceDedupKey,
	validateSourceEvidence,
} from "../core/contracts/evidence.ts";
import type { GraphStore } from "../core/ports.ts";

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

const isString = (v: unknown): v is string => typeof v === "string";

/** Provenance points are (chatId, messageId) pairs — message-granular. */
const isProvenancePoint = (v: unknown): v is ProvenancePoint =>
	isRecord(v) && isString(v.chatId) && isString(v.messageId);

const isGraphNode = (v: unknown): v is GraphNode =>
	isRecord(v) &&
	isString(v.id) &&
	isString(v.name) &&
	isString(v.statement) &&
	Array.isArray(v.aliases) &&
	v.aliases.every(isString) &&
	isString(v.createdAt) &&
	Array.isArray(v.provenance) &&
	v.provenance.every(isProvenancePoint);

/** A chain line: premises ≥ 1 (a chain IS an argument — bare propositions
 *  ride the node ledger alone), every member a string, conclusion a string.
 *  Endpoint EXISTENCE is the derivation's concern (it drops dangling
 *  chains); the store only shapes. */
const isGraphChain = (v: unknown): v is GraphChain =>
	isRecord(v) &&
	isString(v.id) &&
	Array.isArray(v.premises) &&
	v.premises.length > 0 &&
	v.premises.every(isString) &&
	isString(v.conclusion) &&
	Array.isArray(v.provenance) &&
	v.provenance.every(isProvenancePoint) &&
	isString(v.createdAt);

const isCheckpoint = (v: unknown): v is SessionCheckpoint =>
	isRecord(v) && isString(v.chatId) && isString(v.foldedAt);

const isCoverageEntry = (v: unknown): v is CoverageEntry =>
	isRecord(v) && isString(v.chatId) && isString(v.fp) && typeof v.tokens === "number" && isString(v.foldedAt);

const isPosition = (v: unknown): v is Position =>
	isRecord(v) && typeof v.x === "number" && Number.isFinite(v.x) && typeof v.y === "number" && Number.isFinite(v.y);

const isNotesSource = (v: unknown): v is NotesSource =>
	isRecord(v) && isString(v.id) && isString(v.filePath) && isString(v.importedAt);

export function createGraphStore(graphDir: string = PATHS.graph): GraphStore {
	const resolvedGraphDir = path.resolve(graphDir);

	const nodesFile = path.join(resolvedGraphDir, "nodes.jsonl");
	const chainsFile = path.join(resolvedGraphDir, "chains.jsonl");
	const sessionsFile = path.join(resolvedGraphDir, "sessions.jsonl");
	const coverageFile = path.join(resolvedGraphDir, "coverage.jsonl");
	const sourcesFile = path.join(resolvedGraphDir, "sources.json");
	const positionsFile = path.join(resolvedGraphDir, "positions.json");
	const formatFile = path.join(resolvedGraphDir, "format.json");
	const evidenceFile = path.join(resolvedGraphDir, "evidence.jsonl");

	// Purge legacy ledgers in this graphDir
	for (const legacy of ["edges.jsonl", "events.jsonl"]) {
		const file = path.join(resolvedGraphDir, legacy);
		try {
			if (fs.existsSync(file)) {
				fs.rmSync(file);
				console.info(`[graph-store] purged legacy ledger: ${file}`);
			}
		} catch (err) {
			console.warn(`[graph-store] could not purge legacy ledger ${file}:`, err);
		}
	}

	function appendLine<T>(file: string, record: T): void {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		ensureGraphFormat(formatFile);
		fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf-8");
	}

	function readRawLines(file: string): unknown[] {
		let raw: string;
		try {
			raw = fs.readFileSync(file, "utf-8");
		} catch {
			return []; // no ledger yet — nothing has ever been emitted
		}
		const out: unknown[] = [];
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (trimmed.length === 0) continue;
			try {
				out.push(JSON.parse(trimmed));
			} catch {
				// Corrupt line: skip rather than fail the whole read
			}
		}
		return out;
	}

	function readValid<T>(file: string, isValid: (v: unknown) => v is T): T[] {
		assertGraphFormat(formatFile);
		return readRawLines(file).filter(isValid);
	}

	function readPositionMap(): Record<string, Position> {
		let raw: string;
		try {
			raw = fs.readFileSync(positionsFile, "utf-8");
		} catch {
			return {};
		}
		try {
			const parsed: unknown = JSON.parse(raw);
			if (!isRecord(parsed) || !isRecord(parsed.positions)) return {};
			const out: Record<string, Position> = {};
			for (const [id, value] of Object.entries(parsed.positions)) {
				if (isPosition(value)) out[id] = { x: value.x, y: value.y };
			}
			return out;
		} catch {
			return {};
		}
	}

	function writePositionMap(positions: Record<string, Position>): void {
		writeAtomicJsonSync(positionsFile, { positions, updatedAt: new Date().toISOString() });
	}

	function readSourceMap(): Record<string, NotesSource> {
		assertGraphFormat(formatFile);
		let raw: string;
		try {
			raw = fs.readFileSync(sourcesFile, "utf-8");
		} catch {
			return {};
		}
		try {
			const parsed: unknown = JSON.parse(raw);
			if (!isRecord(parsed)) return {};
			const out: Record<string, NotesSource> = {};
			for (const [id, value] of Object.entries(parsed)) {
				if (isNotesSource(value)) out[id] = value;
			}
			return out;
		} catch {
			return {};
		}
	}

	function writeSourceMap(map: Record<string, NotesSource>): void {
		ensureGraphFormat(formatFile);
		writeAtomicJsonSync(sourcesFile, map);
	}

	let evidenceLoaded = false;
	const evidenceList: SourceEvidence[] = [];
	const evidenceById = new Map<string, SourceEvidence>();
	const evidenceByProposition = new Map<string, SourceEvidence[]>();
	const evidenceByDocument = new Map<string, SourceEvidence[]>();
	const evidenceBySource = new Map<string, SourceEvidence[]>();
	const evidenceDedupMap = new Map<string, SourceEvidence>();

	let evidenceLock = Promise.resolve();
	function withEvidenceLock<T>(fn: () => Promise<T> | T): Promise<T> {
		const next = evidenceLock.then(fn, fn);
		evidenceLock = next.then(() => {}, () => {});
		return next;
	}

	function indexEvidenceRecord(ev: SourceEvidence): void {
		evidenceList.push(ev);
		evidenceById.set(ev.id, ev);
		evidenceDedupMap.set(computeEvidenceDedupKey(ev), ev);

		const propList = evidenceByProposition.get(ev.propositionId) ?? [];
		propList.push(ev);
		evidenceByProposition.set(ev.propositionId, propList);

		const docList = evidenceByDocument.get(ev.documentId) ?? [];
		docList.push(ev);
		evidenceByDocument.set(ev.documentId, docList);

		const srcList = evidenceBySource.get(ev.sourceId) ?? [];
		srcList.push(ev);
		evidenceBySource.set(ev.sourceId, srcList);
	}

	function rebuildEvidenceIndices(records: SourceEvidence[]): void {
		evidenceList.length = 0;
		evidenceById.clear();
		evidenceByProposition.clear();
		evidenceByDocument.clear();
		evidenceBySource.clear();
		evidenceDedupMap.clear();
		for (const rec of records) {
			indexEvidenceRecord(rec);
		}
	}

	function ensureEvidenceLoaded(): void {
		if (evidenceLoaded) return;
		evidenceLoaded = true;
		if (!fs.existsSync(evidenceFile)) return;

		const rawLines = readRawLines(evidenceFile);
		for (const raw of rawLines) {
			const parsed = sourceEvidenceSchema.safeParse(raw);
			if (parsed.success) {
				const ev = parsed.data;
				const existingById = evidenceById.get(ev.id);
				const dedupKey = computeEvidenceDedupKey(ev);
				const existingByDedup = evidenceDedupMap.get(dedupKey);

				if (existingById) {
					existingById.status = ev.status;
					Object.assign(existingById, ev);
					continue;
				}
				if (existingByDedup && existingByDedup.status !== ev.status) {
					existingByDedup.status = ev.status;
				}
				indexEvidenceRecord(ev);
			}
		}
	}

	async function appendEvidenceBatch(records: SourceEvidence[]): Promise<void> {
		return withEvidenceLock(async () => {
			ensureEvidenceLoaded();
			const toAppend: SourceEvidence[] = [];
			for (const raw of records) {
				const ev = validateSourceEvidence(raw);
				const dedupKey = computeEvidenceDedupKey(ev);
				const existingById = evidenceById.get(ev.id);
				const existingByDedup = evidenceDedupMap.get(dedupKey);

				if (existingById && existingById.status === ev.status) {
					continue;
				}
				if (existingByDedup && existingByDedup.status === ev.status) {
					continue;
				}

				if (existingById && existingById.status !== ev.status) {
					existingById.status = ev.status;
					Object.assign(existingById, ev);
					toAppend.push(ev);
					continue;
				}

				if (existingByDedup && existingByDedup.status !== ev.status) {
					existingByDedup.status = ev.status;
				}

				indexEvidenceRecord(ev);
				toAppend.push(ev);
			}

			if (toAppend.length > 0) {
				fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
				ensureGraphFormat(formatFile);
				const payload = toAppend.map((ev) => JSON.stringify(ev)).join("\n") + "\n";
				fs.appendFileSync(evidenceFile, payload, "utf-8");
			}
		});
	}

	async function appendEvidence(evidence: SourceEvidence | SourceEvidence[]): Promise<void> {
		const list = Array.isArray(evidence) ? evidence : [evidence];
		return appendEvidenceBatch(list);
	}

	async function getEvidenceForProposition(propositionId: string): Promise<SourceEvidence[]> {
		ensureEvidenceLoaded();
		const list = evidenceByProposition.get(propositionId) ?? [];
		return list.map((ev) => ({ ...ev }));
	}

	async function getEvidenceForDocument(documentId: string): Promise<SourceEvidence[]> {
		ensureEvidenceLoaded();
		const list = evidenceByDocument.get(documentId) ?? [];
		return list.map((ev) => ({ ...ev }));
	}

	async function getEvidenceForSource(sourceId: string): Promise<SourceEvidence[]> {
		ensureEvidenceLoaded();
		const list = evidenceBySource.get(sourceId) ?? [];
		return list.map((ev) => ({ ...ev }));
	}

	async function readEvidence(options?: { status?: "active" | "superseded" }): Promise<SourceEvidence[]> {
		ensureEvidenceLoaded();
		const filtered = options?.status
			? evidenceList.filter((ev) => ev.status === options.status)
			: evidenceList;
		return filtered.map((ev) => ({ ...ev }));
	}

	async function removeEvidenceForDocument(documentId: string): Promise<void> {
		return withEvidenceLock(async () => {
			ensureEvidenceLoaded();
			const remaining = evidenceList.filter((ev) => ev.documentId !== documentId);
			rebuildEvidenceIndices(remaining);
			fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
			ensureGraphFormat(formatFile);
			const body = remaining.map((ev) => JSON.stringify(ev)).join("\n") + (remaining.length > 0 ? "\n" : "");
			writeAtomicFileSync(evidenceFile, body);
		});
	}

	return {
		appendNode(node: GraphNode): void {
			appendLine(nodesFile, node);
		},
		readNodes(): GraphNode[] {
			return readValid(nodesFile, isGraphNode);
		},

		appendChain(assertion: GraphChain): void {
			appendLine(chainsFile, assertion);
		},
		readChains(): GraphChain[] {
			return readValid(chainsFile, isGraphChain);
		},

		appendCheckpoint(checkpoint: SessionCheckpoint): void {
			appendLine(sessionsFile, checkpoint);
		},
		readCheckpoints(): SessionCheckpoint[] {
			return readValid(sessionsFile, isCheckpoint);
		},

		appendCoverage(entry: CoverageEntry): void {
			appendLine(coverageFile, entry);
		},
		readCoverage(): CoverageEntry[] {
			return readValid(coverageFile, isCoverageEntry);
		},

		upsertSource(source: NotesSource): void {
			const all = readSourceMap();
			const prev = all[source.id];
			all[source.id] = prev ? { ...source, extractions: prev.extractions } : source;
			writeSourceMap(all);
		},
		readSources(): NotesSource[] {
			return Object.values(readSourceMap());
		},
		appendSourceUsage(id: string, entry: ExtractionRunUsage): void {
			const all = readSourceMap();
			const source = all[id];
			if (!source) return;
			source.extractions = source.extractions?.some((r) => r.startedAt === entry.startedAt)
				? source.extractions
				: [...(source.extractions ?? []), entry];
			writeSourceMap(all);
		},

		readPositions(): Record<string, Position> {
			return readPositionMap();
		},
		writePositions(positions: Record<string, Position>): void {
			writePositionMap(positions);
		},

		appendEvidence,
		appendEvidenceBatch,
		getEvidenceForProposition,
		getEvidenceForDocument,
		getEvidenceForSource,
		readEvidence,
		removeEvidenceForDocument,

		rewriteLedgers(next: {
			nodes?: GraphNode[];
			chains?: GraphChain[];
			coverage?: CoverageEntry[];
			checkpoints?: SessionCheckpoint[];
			evidence?: SourceEvidence[];
		}): void {
			if (next.nodes) {
				const body = next.nodes.map((r) => JSON.stringify(r)).join("\n") + (next.nodes.length > 0 ? "\n" : "");
				writeAtomicFileSync(nodesFile, body);
			}
			if (next.chains) {
				const body = next.chains.map((r) => JSON.stringify(r)).join("\n") + (next.chains.length > 0 ? "\n" : "");
				writeAtomicFileSync(chainsFile, body);
			}
			if (next.coverage) {
				const body = next.coverage.map((r) => JSON.stringify(r)).join("\n") + (next.coverage.length > 0 ? "\n" : "");
				writeAtomicFileSync(coverageFile, body);
			}
			if (next.checkpoints) {
				const body = next.checkpoints.map((r) => JSON.stringify(r)).join("\n") + (next.checkpoints.length > 0 ? "\n" : "");
				writeAtomicFileSync(sessionsFile, body);
			}
			if (next.evidence) {
				ensureEvidenceLoaded();
				rebuildEvidenceIndices(next.evidence);
				fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
				ensureGraphFormat(formatFile);
				const body = next.evidence.map((record) => JSON.stringify(record)).join("\n") + (next.evidence.length > 0 ? "\n" : "");
				writeAtomicFileSync(evidenceFile, body);
			}
		},

	};
}


export const graphStore: GraphStore = createGraphStore(PATHS.graph);
