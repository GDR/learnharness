/**
 * Server Practice Sets Engine & Document Revision Warning Evaluator (Milestone D Slice 5).
 *
 * Coordinates:
 * 1. Scope resolution and immutable graph snapshot capture for practice sets.
 * 2. Document revision snapshot capture for supporting Obsidian notes.
 * 3. Offline pure practice problem generation fallback.
 * 4. Non-destructive document revision warning evaluation against live inventories and vaults.
 */

import crypto from "node:crypto";
import {
	type ProjectContext,
	type GraphNode,
	type SourceCitation,
	type VaultRegistry,
	type SourceDocument,
	type ProblemSet,
	type ScopedProblemSet,
	type DocumentRevisionSnapshot,
	type DocumentRevisionWarning,
	type PracticeProblemItem,
	type PracticeProblemMode,
	type ProblemSetWarningReport,
	type GraphSnapshotSummary,
	validateCreateScopedPracticeSetRequest,
	createObsidianDeepLink,
} from "../core/index.ts";
import { validateAndResolveStudyScope } from "./scope.ts";
import { captureScopedGraphSnapshot } from "./study-session.ts";
import { getVaultRegistry } from "../store/vaults.ts";

/**
 * Evaluates warning status for a single document snapshot against the live environment.
 *
 * Precedence Order:
 * 1. "unavailable": Vault is disconnected or marked unavailable.
 * 2. "deleted": Document missing from inventory or marked status "missing" / "excluded".
 * 3. "moved": Document exists in inventory, but its currentPath differs from snapshot.path.
 * 4. "modified": Document exists at currentPath, but its contentHash differs from snapshot.contentHash.
 * 5. "current": Document exists at currentPath and contentHash matches.
 */
export async function evaluateDocumentWarning(
	snapshot: DocumentRevisionSnapshot,
	context: ProjectContext,
	vaultRegistry: VaultRegistry,
): Promise<DocumentRevisionWarning> {
	// 1. Vault check
	const vault = await vaultRegistry.getVault(snapshot.vaultId);
	const isUnavailable =
		!vault || vault.bindings.length === 0 || vault.bindings.every((b) => b.status === "unavailable");
	if (isUnavailable) {
		return {
			documentId: snapshot.documentId,
			vaultId: snapshot.vaultId,
			vaultName: snapshot.vaultName ?? vault?.displayName ?? snapshot.vaultId,
			originalPath: snapshot.path,
			originalHash: snapshot.contentHash,
			originalRevisionId: snapshot.revisionId,
			status: "unavailable",
			message: `Vault '${snapshot.vaultName ?? snapshot.vaultId}' is disconnected or unavailable`,
		};
	}

	// 2. Inventory check across project sources
	const sources = await context.sources.listSources(context.projectId);
	let liveDoc: SourceDocument | null = null;
	for (const src of sources) {
		if (src.vaultId === snapshot.vaultId) {
			const docs = await context.sources.listDocuments(src.id);
			const match = docs.find((d) => d.id === snapshot.documentId);
			if (match) {
				liveDoc = match;
				break;
			}
		}
	}

	if (!liveDoc || liveDoc.status === "missing" || liveDoc.status === "excluded") {
		return {
			documentId: snapshot.documentId,
			vaultId: snapshot.vaultId,
			vaultName: snapshot.vaultName ?? vault.displayName,
			originalPath: snapshot.path,
			originalHash: snapshot.contentHash,
			originalRevisionId: snapshot.revisionId,
			status: "deleted",
			message: `Source note '${snapshot.path}' was deleted or removed from project sources`,
		};
	}

	// 3. Path change check
	const pathChanged = liveDoc.currentPath !== snapshot.path;
	const hashChanged = liveDoc.contentHash !== snapshot.contentHash;

	if (pathChanged) {
		const deepLink = createObsidianDeepLink({
			vaultName: vault.displayName,
			filePath: liveDoc.currentPath,
		});
		return {
			documentId: snapshot.documentId,
			vaultId: snapshot.vaultId,
			vaultName: vault.displayName,
			originalPath: snapshot.path,
			currentPath: liveDoc.currentPath,
			originalHash: snapshot.contentHash,
			currentHash: liveDoc.contentHash,
			originalRevisionId: snapshot.revisionId,
			currentRevisionId: liveDoc.revisionId,
			status: "moved",
			message: `Note moved from '${snapshot.path}' to '${liveDoc.currentPath}'${hashChanged ? " (and modified)" : ""}`,
			deepLink,
		};
	}

	// 4. Content modification check
	if (hashChanged) {
		const deepLink = createObsidianDeepLink({
			vaultName: vault.displayName,
			filePath: snapshot.path,
		});
		return {
			documentId: snapshot.documentId,
			vaultId: snapshot.vaultId,
			vaultName: vault.displayName,
			originalPath: snapshot.path,
			currentPath: snapshot.path,
			originalHash: snapshot.contentHash,
			currentHash: liveDoc.contentHash,
			originalRevisionId: snapshot.revisionId,
			currentRevisionId: liveDoc.revisionId,
			status: "modified",
			message: "Note content changed since practice set was generated (hash mismatch)",
			deepLink,
		};
	}

	// 5. Current
	const deepLink = createObsidianDeepLink({
		vaultName: vault.displayName,
		filePath: snapshot.path,
	});
	return {
		documentId: snapshot.documentId,
		vaultId: snapshot.vaultId,
		vaultName: vault.displayName,
		originalPath: snapshot.path,
		currentPath: snapshot.path,
		originalHash: snapshot.contentHash,
		currentHash: snapshot.contentHash,
		originalRevisionId: snapshot.revisionId,
		currentRevisionId: liveDoc.revisionId,
		status: "current",
		message: "Document is current",
		deepLink,
	};
}

/**
 * Batch evaluates document revision warnings for all supporting notes of a practice set.
 * Non-destructive: does not modify or delete learner practice records.
 */
export async function checkDocumentRevisionWarnings(
	problemSet: ProblemSet,
	context: ProjectContext,
	customVaultRegistry?: VaultRegistry | null,
): Promise<ProblemSetWarningReport> {
	const vaultRegistry = customVaultRegistry ?? getVaultRegistry();
	const snapshots = Object.values(problemSet.sourceSnapshots ?? {});
	const warnings: DocumentRevisionWarning[] = [];

	for (const snap of snapshots) {
		const warning = await evaluateDocumentWarning(snap, context, vaultRegistry);
		warnings.push(warning);
	}

	const hasWarnings = warnings.some((w) => w.status !== "current");
	const warningCount = warnings.filter((w) => w.status !== "current").length;

	return {
		problemSetId: problemSet.id,
		projectId: problemSet.projectId,
		hasWarnings,
		warningCount,
		warnings,
		evaluatedAt: new Date().toISOString(),
	};
}

/**
 * Deterministic Pure Practice Problem Generator.
 * Creates structured recall, discrimination, and composition practice problems from proposition nodes and citations.
 */
export function generatePracticeProblems(options: {
	nodes: GraphNode[];
	problemCount: number;
	modes?: PracticeProblemMode[];
	citations?: SourceCitation[];
	sourceSnapshots?: Record<string, DocumentRevisionSnapshot>;
}): PracticeProblemItem[] {
	const {
		nodes,
		problemCount,
		modes = ["recall", "discrimination", "composition"],
		citations = [],
		sourceSnapshots = {},
	} = options;
	if (nodes.length === 0) return [];

	const effectiveCount = Math.max(1, Math.min(problemCount, 20));
	const problems: PracticeProblemItem[] = [];

	for (let i = 0; i < effectiveCount; i++) {
		const primaryNode = nodes[i % nodes.length]!;
		const mode = modes[i % modes.length] ?? "recall";
		const id = `prob_${Date.now().toString(36)}_${i}_${crypto.randomUUID().slice(0, 6)}`;
		const createdAt = new Date().toISOString();

		let statement = "";
		let modelSolution = "";
		const targetPropositionIds = [primaryNode.id];

		if (mode === "recall") {
			statement = `Explain the concept of **${primaryNode.name}** and state its key definition or principle.`;
			modelSolution = primaryNode.statement
				? `**${primaryNode.name}**: ${primaryNode.statement}`
				: `Recall definition for ${primaryNode.name}.`;
		} else if (mode === "discrimination") {
			const secondaryNode = nodes[(i + 1) % nodes.length]!;
			if (secondaryNode && secondaryNode.id !== primaryNode.id) {
				targetPropositionIds.push(secondaryNode.id);
				statement = `Compare and contrast **${primaryNode.name}** with **${secondaryNode.name}**. What are the crucial distinguishing criteria?`;
				modelSolution = `**${primaryNode.name}**: ${primaryNode.statement || primaryNode.name}\n\n**${secondaryNode.name}**: ${secondaryNode.statement || secondaryNode.name}\n\nDistinction: Note how each proposition operates within its domain and scope.`;
			} else {
				statement = `Analyze the conditions under which **${primaryNode.name}** holds true versus when it does not apply.`;
				modelSolution = primaryNode.statement
					? `Key condition: ${primaryNode.statement}`
					: `Analyze boundaries of ${primaryNode.name}.`;
			}
		} else {
			// composition
			const premises = nodes.slice(0, Math.min(3, nodes.length));
			statement = `Synthesize how **${primaryNode.name}** relates to and connects with ${premises.map((p) => `**${p.name}**`).join(", ")} to solve a composite problem.`;
			modelSolution =
				`Composite solution applying ${primaryNode.name}:\n` +
				premises.map((p) => `- ${p.name}: ${p.statement || p.name}`).join("\n");
		}

		problems.push({
			id,
			statement,
			mode,
			targetPropositionIds,
			modelSolution,
			citations: citations.slice(0, 3),
			sourceSnapshots,
			createdAt,
		});
	}

	return problems;
}

/**
 * Creates a scoped practice set with immutable graph snapshot and document revision baselines.
 */
export async function createScopedPracticeSet(
	context: ProjectContext,
	rawRequest: unknown,
	customVaultRegistry?: VaultRegistry | null,
): Promise<ScopedProblemSet> {
	const req = validateCreateScopedPracticeSetRequest(rawRequest);
	const resolved = await validateAndResolveStudyScope(req.scope, context);

	const allNodes = typeof context.graph.readNodes === "function" ? context.graph.readNodes() : [];
	const allChains = typeof context.graph.readChains === "function" ? context.graph.readChains() : [];

	let scopedNodes: GraphNode[] = [];

	if (req.nodeIds && req.nodeIds.length > 0) {
		const validNodeMap = new Map(allNodes.map((n) => [n.id, n]));
		const targetIds = new Set(req.nodeIds.filter((id) => validNodeMap.has(id)));
		if (resolved.includePrerequisites && allChains.length > 0) {
			const queue = [...targetIds];
			while (queue.length > 0) {
				const current = queue.shift()!;
				for (const chain of allChains) {
					if (chain.conclusion === current) {
						for (const premise of chain.premises) {
							if (!targetIds.has(premise)) {
								targetIds.add(premise);
								queue.push(premise);
							}
						}
					}
				}
			}
		}
		scopedNodes = allNodes.filter((n) => targetIds.has(n.id));
	} else {
		const snapshotResult = await captureScopedGraphSnapshot(context, resolved);
		scopedNodes = snapshotResult.scopedNodes;
	}

	const scopedNodeIdSet = new Set(scopedNodes.map((n) => n.id));
	const scopedChains = allChains.filter(
		(c) => scopedNodeIdSet.has(c.conclusion) && c.premises.every((p) => scopedNodeIdSet.has(p)),
	);

	// Get generation and compute checksum
	const genRecord =
		typeof context.graph.getGeneration === "function" ? await context.graph.getGeneration() : undefined;
	const generation = genRecord?.generation ?? 0;

	const sortedNodeIds = scopedNodes.map((n) => n.id).sort();
	const sortedChainIds = scopedChains.map((c) => c.id).sort();
	const hasher = crypto.createHash("sha256");
	hasher.update(JSON.stringify({ generation, nodes: sortedNodeIds, chains: sortedChainIds }));
	const checksum = hasher.digest("hex");

	let evidenceCount: number | undefined;
	if (typeof context.graph.readEvidence === "function") {
		try {
			const allEvidence = await context.graph.readEvidence({ status: "active" });
			const scopedIdSet = new Set(sortedNodeIds);
			evidenceCount = allEvidence.filter((ev) => scopedIdSet.has(ev.propositionId)).length;
		} catch {
			// optional readEvidence
		}
	}

	const snapshot: GraphSnapshotSummary = {
		generation,
		nodeCount: scopedNodes.length,
		chainCount: scopedChains.length,
		...(evidenceCount !== undefined ? { evidenceCount } : {}),
		nodeIds: sortedNodeIds,
		capturedAt: new Date().toISOString(),
		checksum,
	};

	// Extract DocumentRevisionSnapshots & Citations
	const sourceSnapshots: Record<string, DocumentRevisionSnapshot> = {};
	const citations: SourceCitation[] = [];
	const sources = await context.sources.listSources(context.projectId);
	const vaultRegistry = customVaultRegistry ?? getVaultRegistry();

	for (const node of scopedNodes) {
		const evidenceList =
			typeof context.graph.getEvidenceForProposition === "function"
				? await context.graph.getEvidenceForProposition(node.id)
				: [];
		for (const ev of evidenceList) {
			if (!sourceSnapshots[ev.documentId]) {
				const src = sources.find((s) => s.id === ev.sourceId);
				if (src) {
					const docs = await context.sources.listDocuments(src.id);
					const doc = docs.find((d) => d.id === ev.documentId);
					if (doc) {
						const vault = await vaultRegistry.getVault(doc.vaultId);
						sourceSnapshots[doc.id] = {
							documentId: doc.id,
							vaultId: doc.vaultId,
							vaultName: vault?.displayName ?? doc.vaultId,
							path: doc.currentPath,
							contentHash: doc.contentHash,
							revisionId: doc.revisionId,
							capturedAt: new Date().toISOString(),
						};
						if (vault) {
							const deepLink = createObsidianDeepLink({
								vaultName: vault.displayName,
								filePath: doc.currentPath,
								heading: ev.heading,
								blockId: ev.location?.blockId,
							});
							citations.push({
								sourceId: ev.sourceId,
								vaultId: doc.vaultId,
								vaultName: vault.displayName,
								documentId: doc.id,
								documentPath: doc.currentPath,
								sectionHeading: ev.heading,
								headingHierarchy: ev.headingHierarchy ?? [],
								lineRange: { start: 1, end: 1 },
								characterRange: ev.range ?? { startOffset: 0, endOffset: 0 },
								deepLink,
								blockId: ev.location?.blockId,
								revisionId: doc.revisionId,
								contentHash: doc.contentHash,
							});
						}
					}
				}
			}
		}
	}

	// Generate practice problem items
	const problems = generatePracticeProblems({
		nodes: scopedNodes,
		problemCount: req.problemCount ?? 3,
		modes: req.modes ?? ["recall", "discrimination", "composition"],
		citations,
		sourceSnapshots,
	});

	const title = req.title?.trim() || `Practice: ${resolved.type} scope (${scopedNodes.length} nodes)`;
	const propositions = Object.fromEntries(
		scopedNodes.map((n) => [n.id, { name: n.name, statement: n.statement ?? n.name }]),
	);

	const created = await context.practice.createProblemSet({
		projectId: context.projectId,
		title,
		nodeIds: scopedNodes.map((n) => n.id),
		propositions,
		chains: scopedChains,
		scope: resolved.scope,
		snapshot,
		problems,
		citations,
		sourceSnapshots,
	});

	return created as ScopedProblemSet;
}
