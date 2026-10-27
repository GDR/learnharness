/**
 * Graph Reconciliation Engine.
 *
 * Implements Scenarios A–D incremental graph reconciliation:
 * - Scenario A: Unchanged document skip and idempotency.
 * - Scenario B: Revision superseding and proposition identity/mastery preservation.
 * - Scenario C: Multi-document shared proposition coexistence.
 * - Scenario D: Deleted document evidence deactivation and orphan detection without destroying learner history.
 *
 * All graph mutations are serialized per-project via getProjectAuditLock(projectId).
 */

import crypto from "node:crypto";
import type { GraphNode } from "../../core/contracts/graph.ts";
import type {
	ExtractedPropositionInput,
	ReconciliationOptions,
	ReconciliationPlan,
	ReconciliationResult,
	ReconciliationScenario,
	SourceReconciliationSummary,
} from "../../core/contracts/reconciler.ts";
import type { SourceEvidence } from "../../core/contracts/evidence.ts";
import { computeEvidenceDedupKey } from "../../core/contracts/evidence.ts";
import type { SourceDocument, ScanResult } from "../../core/contracts/indexing.ts";
import type { GraphStore } from "../../core/ports.ts";
import { getProjectAuditLock, validateProjectId } from "../../core/audit-lock.ts";

/**
 * Matches an extracted proposition against existing graph nodes.
 * Matches by exact statement, known aliases, or case-folded statement/alias.
 */
export function matchPropositionToNode(
	extracted: ExtractedPropositionInput,
	existingNodes: GraphNode[],
): GraphNode | undefined {
	const target = extracted.statement.trim();
	if (!target) return undefined;
	const targetLower = target.toLowerCase();

	// 1. Exact statement match
	for (const node of existingNodes) {
		if (node.statement.trim() === target) return node;
	}
	// 2. Known alias match
	for (const node of existingNodes) {
		if (node.aliases.some((a) => a.trim() === target)) return node;
	}
	// 3. Case-folded statement match
	for (const node of existingNodes) {
		if (node.statement.trim().toLowerCase() === targetLower) return node;
	}
	// 4. Case-folded alias match
	for (const node of existingNodes) {
		if (node.aliases.some((a) => a.trim().toLowerCase() === targetLower)) return node;
	}
	return undefined;
}

export function newGraphNodeId(): string {
	return `n_${crypto.randomBytes(6).toString("hex")}`;
}

export function newEvidenceId(): string {
	return `ev_${crypto.randomBytes(8).toString("hex")}`;
}

export interface ComputePlanInput {
	projectId: string;
	sourceId: string;
	document: SourceDocument;
	extractedPropositions?: ExtractedPropositionInput[];
	existingEvidence: SourceEvidence[];
	existingNodes: GraphNode[];
	allActiveEvidence?: SourceEvidence[];
	options?: ReconciliationOptions;
}

/**
 * Pure function: computes the exact reconciliation plan without side effects or I/O.
 */
export function computeReconciliationPlan(input: ComputePlanInput): ReconciliationPlan {
	const {
		projectId,
		sourceId,
		document,
		extractedPropositions = [],
		existingEvidence,
		existingNodes,
		allActiveEvidence = [],
		options = {},
	} = input;

	const docId = document.id;
	const revId = document.revisionId;
	const deletionPolicy = options.deletionPolicy ?? "deactivate";

	// ─── SCENARIO D: DELETED / MISSING DOCUMENT ──────────────────────────────
	if (document.status === "missing") {
		const activeDocEvidence = existingEvidence.filter(
			(e) => e.documentId === docId && e.status === "active",
		);

		if (deletionPolicy === "retain" || activeDocEvidence.length === 0) {
			return {
				projectId,
				sourceId,
				documentId: docId,
				revisionId: revId,
				scenario: "D_DELETED",
				evidenceToAppend: [],
				evidenceToSupersede: [],
				nodesToAppend: [],
				unchangedEvidenceCount: activeDocEvidence.length,
				reusedPropositionIds: [],
				createdPropositionIds: [],
				orphanedPropositionIds: [],
				stillSupportedPropositionIds: [],
				dedupSkippedCount: 0,
			};
		}

		// Deduplicate active evidence by ID before superseding
		const toSupersedeMap = new Map<string, SourceEvidence>();
		for (const ev of activeDocEvidence) {
			toSupersedeMap.set(ev.id, { ...ev, status: "superseded" });
		}
		const evidenceToSupersede: SourceEvidence[] = Array.from(toSupersedeMap.values());

		const orphanedPropositionIds: string[] = [];
		const stillSupportedPropositionIds: string[] = [];

		const distinctPropIds = [...new Set(activeDocEvidence.map((e) => e.propositionId))];
		for (const propId of distinctPropIds) {
			const hasOtherActive = allActiveEvidence.some(
				(e) => e.propositionId === propId && e.documentId !== docId && e.status === "active",
			);
			if (hasOtherActive) {
				stillSupportedPropositionIds.push(propId);
			} else {
				orphanedPropositionIds.push(propId);
			}
		}

		return {
			projectId,
			sourceId,
			documentId: docId,
			revisionId: revId,
			scenario: "D_DELETED",
			evidenceToAppend: [],
			evidenceToSupersede,
			nodesToAppend: [],
			unchangedEvidenceCount: 0,
			reusedPropositionIds: [],
			createdPropositionIds: [],
			orphanedPropositionIds,
			stillSupportedPropositionIds,
			dedupSkippedCount: 0,
		};
	}

	// ─── SCENARIO A: UNCHANGED DOCUMENT ──────────────────────────────────────
	const activeSameRevEvidence = existingEvidence.filter(
		(e) => e.documentId === docId && e.status === "active" && e.revisionId === revId,
	);

	if (activeSameRevEvidence.length > 0 && !options.forceRescan) {
		return {
			projectId,
			sourceId,
			documentId: docId,
			revisionId: revId,
			scenario: "A_UNCHANGED",
			evidenceToAppend: [],
			evidenceToSupersede: [],
			nodesToAppend: [],
			unchangedEvidenceCount: activeSameRevEvidence.length,
			reusedPropositionIds: [],
			createdPropositionIds: [],
			orphanedPropositionIds: [],
			stillSupportedPropositionIds: [],
			dedupSkippedCount: 0,
		};
	}

	// ─── SCENARIOS B & C: MODIFIED OR NEW DOCUMENT ───────────────────────────
	const priorActiveEvidence = existingEvidence.filter(
		(e) =>
			e.documentId === docId &&
			e.status === "active" &&
			(options.forceRescan ? true : e.revisionId !== revId),
	);

	const priorActiveMap = new Map<string, SourceEvidence>();
	for (const ev of priorActiveEvidence) {
		priorActiveMap.set(ev.id, { ...ev, status: "superseded" });
	}
	const evidenceToSupersede: SourceEvidence[] = Array.from(priorActiveMap.values());

	const nodesToAppend: GraphNode[] = [];
	const evidenceToAppend: SourceEvidence[] = [];
	const reusedPropositionIds: string[] = [];
	const createdPropositionIds: string[] = [];
	const stillSupportedPropositionIds: string[] = [];

	const workingNodes = [...existingNodes];
	const now = new Date().toISOString();
	const seenDedupKeys = new Set<string>();
	let dedupSkippedCount = 0;

	for (const ext of extractedPropositions) {
		const matcher = options.matchProposition ?? matchPropositionToNode;
		const matchedNode = matcher(ext, workingNodes);
		let propId: string;

		if (matchedNode) {
			propId = matchedNode.id;
			if (!reusedPropositionIds.includes(propId)) {
				reusedPropositionIds.push(propId);
			}
			// Scenario C: check if other active evidence exists for this proposition in another document
			const hasOtherActive = allActiveEvidence.some(
				(e) => e.propositionId === propId && e.documentId !== docId && e.status === "active",
			);
			if (hasOtherActive && !stillSupportedPropositionIds.includes(propId)) {
				stillSupportedPropositionIds.push(propId);
			}
		} else {
			propId = newGraphNodeId();
			const newNode: GraphNode = {
				id: propId,
				name: ext.name || ext.heading || ext.statement.slice(0, 40),
				statement: ext.statement,
				aliases: ext.aliases ? [...ext.aliases] : [],
				createdAt: now,
				provenance: [{ chatId: `src_${sourceId}`, messageId: docId }],
			};
			nodesToAppend.push(newNode);
			workingNodes.push(newNode);
			createdPropositionIds.push(propId);
		}

		const newEvidence: SourceEvidence = {
			id: newEvidenceId(),
			projectId,
			sourceId,
			documentId: docId,
			documentPath: document.currentPath,
			revisionId: revId,
			propositionId: propId,
			chunkId: ext.chunkId,
			heading: ext.heading,
			headingHierarchy: ext.headingHierarchy ?? [],
			range: ext.range,
			location: ext.location ?? {
				heading: ext.heading,
				startOffset: ext.range?.startOffset ?? 0,
				endOffset: ext.range?.endOffset ?? 0,
			},
			excerpt: ext.excerpt,
			confidence: ext.confidence ?? 1.0,
			provenance: ext.provenance ?? "explicit-source",
			status: "active",
			extractorVersion: ext.extractorVersion ?? options.extractorVersion ?? "1.0.0",
			recordedAt: now,
		};

		const dedupKey = computeEvidenceDedupKey(newEvidence);
		if (!seenDedupKeys.has(dedupKey)) {
			seenDedupKeys.add(dedupKey);
			evidenceToAppend.push(newEvidence);
		} else {
			dedupSkippedCount++;
		}
	}

	const scenario: ReconciliationScenario =
		stillSupportedPropositionIds.length > 0 && priorActiveEvidence.length === 0
			? "C_SHARED"
			: "B_MODIFIED";

	return {
		projectId,
		sourceId,
		documentId: docId,
		revisionId: revId,
		scenario,
		evidenceToAppend,
		evidenceToSupersede,
		nodesToAppend,
		unchangedEvidenceCount: 0,
		reusedPropositionIds,
		createdPropositionIds,
		orphanedPropositionIds: [],
		stillSupportedPropositionIds,
		dedupSkippedCount,
	};
}

export interface ApplyPlanDeps {
	graphStore: GraphStore;
	projectId?: string;
	baseGeneration?: number;
}

/**
 * Commits a reconciliation plan atomically to GraphStore under project audit lock.
 */
export async function applyReconciliationPlan(
	plan: ReconciliationPlan,
	deps: ApplyPlanDeps,
): Promise<ReconciliationResult> {
	const startTime = Date.now();
	const targetProjectId = validateProjectId(deps.projectId ?? plan.projectId);
	const withLock = getProjectAuditLock(targetProjectId);

	return withLock(async () => {
		// 1. If unchanged, skip writes
		if (plan.scenario === "A_UNCHANGED") {
			return {
				projectId: plan.projectId,
				sourceId: plan.sourceId,
				documentId: plan.documentId,
				revisionId: plan.revisionId,
				status: "skipped",
				scenario: plan.scenario,
				stats: {
					evidenceAppended: 0,
					evidenceSuperseded: 0,
					propositionsCreated: 0,
					propositionsReused: 0,
					propositionsOrphaned: 0,
					durationMs: Date.now() - startTime,
				},
				diagnostics: {
					reusedPropositionIds: [],
					createdPropositionIds: [],
					orphanedPropositionIds: [],
					stillSupportedPropositionIds: [],
					dedupSkippedCount: plan.unchangedEvidenceCount,
				},
			};
		}

		// 2. Scenario D with empty evidence -> skip commit
		if (plan.scenario === "D_DELETED" && plan.evidenceToSupersede.length === 0) {
			return {
				projectId: plan.projectId,
				sourceId: plan.sourceId,
				documentId: plan.documentId,
				revisionId: plan.revisionId,
				status: "skipped",
				scenario: plan.scenario,
				stats: {
					evidenceAppended: 0,
					evidenceSuperseded: 0,
					propositionsCreated: 0,
					propositionsReused: 0,
					propositionsOrphaned: 0,
					durationMs: Date.now() - startTime,
				},
				diagnostics: {
					reusedPropositionIds: [],
					createdPropositionIds: [],
					orphanedPropositionIds: [],
					stillSupportedPropositionIds: [],
					dedupSkippedCount: plan.unchangedEvidenceCount,
				},
			};
		}

		const batch = [...plan.evidenceToSupersede, ...plan.evidenceToAppend];

		// Milestone C Slice 6: Atomic generation commit
		if (typeof deps.graphStore.commitGeneration === "function") {
			const commitRes = await deps.graphStore.commitGeneration({
				projectId: targetProjectId,
				nodesToAppend: plan.nodesToAppend,
				evidenceBatch: batch,
				sourceId: plan.sourceId,
				documentId: plan.documentId,
				baseGeneration: deps.baseGeneration ?? plan.baseGeneration,
				description: `Reconcile document ${plan.documentId} (${plan.scenario})`,
			});

			const status: ReconciliationResult["status"] =
				plan.scenario === "D_DELETED"
					? plan.orphanedPropositionIds.length > 0
						? "orphaned"
						: "superseded"
					: "applied";

			return {
				projectId: plan.projectId,
				sourceId: plan.sourceId,
				documentId: plan.documentId,
				revisionId: plan.revisionId,
				status,
				scenario: plan.scenario,
				generation: commitRes.generation,
				commitId: commitRes.commitId,
				stats: {
					evidenceAppended: plan.evidenceToAppend.length,
					evidenceSuperseded: plan.evidenceToSupersede.length,
					propositionsCreated: plan.nodesToAppend.length,
					propositionsReused: plan.reusedPropositionIds.length,
					propositionsOrphaned: plan.orphanedPropositionIds.length,
					durationMs: Date.now() - startTime,
				},
				diagnostics: {
					reusedPropositionIds: plan.reusedPropositionIds,
					createdPropositionIds: plan.createdPropositionIds,
					orphanedPropositionIds: plan.orphanedPropositionIds,
					stillSupportedPropositionIds: plan.stillSupportedPropositionIds,
					dedupSkippedCount: plan.dedupSkippedCount ?? 0,
				},
			};
		}

		// Fallback for GraphStore without commitGeneration
		for (const node of plan.nodesToAppend) {
			deps.graphStore.appendNode(node);
		}
		if (batch.length > 0) {
			if (typeof deps.graphStore.appendEvidenceBatch === "function") {
				await deps.graphStore.appendEvidenceBatch(batch);
			} else if (typeof deps.graphStore.appendEvidence === "function") {
				await deps.graphStore.appendEvidence(batch);
			}
		}

		const status: ReconciliationResult["status"] =
			plan.scenario === "D_DELETED"
				? plan.evidenceToSupersede.length === 0
					? "skipped"
					: plan.orphanedPropositionIds.length > 0
						? "orphaned"
						: "superseded"
				: "applied";

		return {
			projectId: plan.projectId,
			sourceId: plan.sourceId,
			documentId: plan.documentId,
			revisionId: plan.revisionId,
			status,
			scenario: plan.scenario,
			stats: {
				evidenceAppended: plan.evidenceToAppend.length,
				evidenceSuperseded: plan.evidenceToSupersede.length,
				propositionsCreated: plan.nodesToAppend.length,
				propositionsReused: plan.reusedPropositionIds.length,
				propositionsOrphaned: plan.orphanedPropositionIds.length,
				durationMs: Date.now() - startTime,
			},
			diagnostics: {
				reusedPropositionIds: plan.reusedPropositionIds,
				createdPropositionIds: plan.createdPropositionIds,
				orphanedPropositionIds: plan.orphanedPropositionIds,
				stillSupportedPropositionIds: plan.stillSupportedPropositionIds,
				dedupSkippedCount: plan.dedupSkippedCount ?? 0,
			},
		};
	});
}

export interface ReconcileDocumentOptions {
	projectId: string;
	sourceId: string;
	document: SourceDocument;
	extractedPropositions?: ExtractedPropositionInput[];
	graphStore: GraphStore;
	options?: ReconciliationOptions;
}

/**
 * Reconciles a single document against GraphStore.
 * Wrapped entirely in getProjectAuditLock to ensure atomic read-plan-commit (Scenario E).
 */
export async function reconcileDocument(
	input: ReconcileDocumentOptions,
): Promise<ReconciliationResult> {
	const { projectId, sourceId, document, extractedPropositions, graphStore, options } = input;
	const withLock = getProjectAuditLock(projectId);

	return withLock(async () => {
		const [existingEvidence, allActiveEvidence, currentGen] = await Promise.all([
			typeof graphStore.getEvidenceForDocument === "function"
				? graphStore.getEvidenceForDocument(document.id)
				: Promise.resolve([]),
			typeof graphStore.readEvidence === "function"
				? graphStore.readEvidence({ status: "active" })
				: Promise.resolve([]),
			typeof graphStore.getGeneration === "function"
				? graphStore.getGeneration()
				: Promise.resolve(undefined),
		]);
		const existingNodes = graphStore.readNodes();

		const plan = computeReconciliationPlan({
			projectId,
			sourceId,
			document,
			extractedPropositions,
			existingEvidence,
			existingNodes,
			allActiveEvidence,
			options,
		});

		if (currentGen) {
			plan.baseGeneration = currentGen.generation;
		}

		return applyReconciliationPlan(plan, {
			graphStore,
			projectId,
			baseGeneration: plan.baseGeneration,
		});
	});
}

export interface ReconcileScanResultOptions {
	projectId: string;
	sourceId: string;
	scanResult: ScanResult;
	extractedPropositionsByDocId?: Record<string, ExtractedPropositionInput[]>;
	graphStore: GraphStore;
	options?: ReconciliationOptions;
}

/**
 * Reconciles an entire ScanResult across all documents.
 */
export async function reconcileScanResult(
	input: ReconcileScanResultOptions,
): Promise<SourceReconciliationSummary> {
	const startTime = Date.now();
	const {
		projectId,
		sourceId,
		scanResult,
		extractedPropositionsByDocId = {},
		graphStore,
		options,
	} = input;

	const results: ReconciliationResult[] = [];
	let totalAppended = 0;
	let totalSuperseded = 0;
	let totalCreated = 0;
	let totalReused = 0;
	let totalOrphaned = 0;

	for (const doc of scanResult.documents) {
		const extracted = extractedPropositionsByDocId[doc.id] ?? [];
		const res = await reconcileDocument({
			projectId,
			sourceId,
			document: doc,
			extractedPropositions: extracted,
			graphStore,
			options,
		});
		results.push(res);
		totalAppended += res.stats.evidenceAppended;
		totalSuperseded += res.stats.evidenceSuperseded;
		totalCreated += res.stats.propositionsCreated;
		totalReused += res.stats.propositionsReused;
		totalOrphaned += res.stats.propositionsOrphaned;
	}

	return {
		projectId,
		sourceId,
		totalDocuments: scanResult.documents.length,
		unchangedDocuments: scanResult.unchangedCount,
		modifiedDocuments: scanResult.modifiedCount,
		addedDocuments: scanResult.addedCount,
		deletedDocuments: scanResult.removedCount,
		totalEvidenceAppended: totalAppended,
		totalEvidenceSuperseded: totalSuperseded,
		totalPropositionsCreated: totalCreated,
		totalPropositionsReused: totalReused,
		totalPropositionsOrphaned: totalOrphaned,
		documentResults: results,
		durationMs: Date.now() - startTime,
	};
}

export class GraphReconciler {
	constructor(
		public readonly projectId: string,
		public readonly graphStore: GraphStore,
		public readonly defaultOptions?: ReconciliationOptions,
	) {}

	async reconcileDocument(
		sourceId: string,
		document: SourceDocument,
		extractedPropositions?: ExtractedPropositionInput[],
		options?: ReconciliationOptions,
	): Promise<ReconciliationResult> {
		return reconcileDocument({
			projectId: this.projectId,
			sourceId,
			document,
			extractedPropositions,
			graphStore: this.graphStore,
			options: { ...this.defaultOptions, ...options },
		});
	}

	async reconcileScanResult(
		sourceId: string,
		scanResult: ScanResult,
		extractedPropositionsByDocId?: Record<string, ExtractedPropositionInput[]>,
		options?: ReconciliationOptions,
	): Promise<SourceReconciliationSummary> {
		return reconcileScanResult({
			projectId: this.projectId,
			sourceId,
			scanResult,
			extractedPropositionsByDocId,
			graphStore: this.graphStore,
			options: { ...this.defaultOptions, ...options },
		});
	}
}
