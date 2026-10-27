/**
 * Server Study Session Engine & Immutable Snapshot Capture (Milestone D Slice 4).
 *
 * Orchestrates:
 * 1. Scope resolution across project sources, documents, and propositions.
 * 2. Immutable graph snapshot capture with prerequisite DAG expansion.
 * 3. Chat session initialization tagged with StudyScope and graph context.
 * 4. Adaptive initial prompt synthesis for Prober and Teacher engines.
 */

import crypto from "node:crypto";
import {
	type ProjectContext,
	type StudyScope,
	type StudySessionRequest,
	type StudySessionResponse,
	type GraphSnapshotSummary,
	type GraphNode,
	type ReasoningChain,
	type GraphContextPick,
	validateStudySessionRequest,
	InvalidStudySessionError,
	chainsForSelection,
	formatChainLine,
	newGraphContextMessage,
	createDefaultStudyScope,
} from "../core/index.ts";
import {
	validateAndResolveStudyScope,
	type ResolvedStudyScope,
} from "./scope.ts";

export interface CreateStudySessionOptions {
	dataDir?: string;
}

/**
 * Captures an immutable graph snapshot for the given resolved scope.
 */
export async function captureScopedGraphSnapshot(
	context: ProjectContext,
	resolvedScope: ResolvedStudyScope,
): Promise<{
	snapshot: GraphSnapshotSummary;
	scopedNodes: GraphNode[];
	scopedChains: ReasoningChain[];
}> {

	const allNodes = typeof context.graph.readNodes === "function" ? context.graph.readNodes() : [];
	const allChains = typeof context.graph.readChains === "function" ? context.graph.readChains() : [];

	let scopedNodes: GraphNode[] = [];

	if (resolvedScope.type === "project") {
		scopedNodes = [...allNodes];
	} else if (resolvedScope.type === "proposition") {
		const targetPropIds = new Set(resolvedScope.resolvedPropositionIds);
		if (resolvedScope.includePrerequisites && allChains.length > 0) {
			const queue = [...targetPropIds];
			while (queue.length > 0) {
				const current = queue.shift()!;
				for (const chain of allChains) {
					if (chain.conclusion === current) {
						for (const premise of chain.premises) {
							if (!targetPropIds.has(premise)) {
								targetPropIds.add(premise);
								queue.push(premise);
							}
						}
					}
				}
			}
		}
		scopedNodes = allNodes.filter((n) => targetPropIds.has(n.id));
	} else if (resolvedScope.type === "source") {
		const targetPropIds = new Set<string>();
		for (const srcId of resolvedScope.resolvedSourceIds) {
			const evidence = typeof context.graph.getEvidenceForSource === "function"
				? await context.graph.getEvidenceForSource(srcId)
				: [];
			for (const ev of evidence) {
				if (ev.status === "active") targetPropIds.add(ev.propositionId);
			}
		}
		if (resolvedScope.includePrerequisites && allChains.length > 0) {
			const queue = [...targetPropIds];
			while (queue.length > 0) {
				const current = queue.shift()!;
				for (const chain of allChains) {
					if (chain.conclusion === current) {
						for (const premise of chain.premises) {
							if (!targetPropIds.has(premise)) {
								targetPropIds.add(premise);
								queue.push(premise);
							}
						}
					}
				}
			}
		}
		scopedNodes = allNodes.filter((n) => targetPropIds.has(n.id));
	} else if (resolvedScope.type === "document") {
		const targetPropIds = new Set<string>();
		for (const docId of resolvedScope.resolvedDocumentIds) {
			const evidence = typeof context.graph.getEvidenceForDocument === "function"
				? await context.graph.getEvidenceForDocument(docId)
				: [];
			for (const ev of evidence) {
				if (ev.status === "active") targetPropIds.add(ev.propositionId);
			}
		}
		if (resolvedScope.includePrerequisites && allChains.length > 0) {
			const queue = [...targetPropIds];
			while (queue.length > 0) {
				const current = queue.shift()!;
				for (const chain of allChains) {
					if (chain.conclusion === current) {
						for (const premise of chain.premises) {
							if (!targetPropIds.has(premise)) {
								targetPropIds.add(premise);
								queue.push(premise);
							}
						}
					}
				}
			}
		}
		scopedNodes = allNodes.filter((n) => targetPropIds.has(n.id));
	} else if (resolvedScope.type === "tag") {
		// Collect propositions from documents carrying the tag or fallback to allNodes
		scopedNodes = [...allNodes];
	}

	const scopedChains = chainsForSelection(scopedNodes, allChains);

	// Get generation and compute checksum
	const genRecord = typeof context.graph.getGeneration === "function"
		? await context.graph.getGeneration()
		: undefined;
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
			// readEvidence is optional
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

	return { snapshot, scopedNodes, scopedChains };
}

/**
 * Creates and initializes a scoped study session in the project.
 */
export async function createStudySession(
	context: ProjectContext,
	rawRequest: unknown,
	_options?: CreateStudySessionOptions,
): Promise<StudySessionResponse> {
	const request = validateStudySessionRequest(rawRequest);

	// 1. Resolve raw scope (harmonizing Obsidian bridge fields if provided)
	let rawScope: StudyScope = request.scope ?? createDefaultStudyScope(context.projectId);

	// If bridge payload provided note/folder path without explicit scope:
	if (!request.scope && request.filePath) {
		const sources = await context.sources.listSources(context.projectId);
		let matchedDocId: string | undefined;
		for (const source of sources) {
			const docs = await context.sources.listDocuments(source.id);
			const found = docs.find((d) => d.currentPath === request.filePath || d.currentPath.endsWith(request.filePath!));
			if (found) {
				matchedDocId = found.id;
				break;
			}
		}
		if (matchedDocId) {
			rawScope = {
				type: "document",
				projectId: context.projectId,
				documentIds: [matchedDocId],
				includePrerequisites: false,
				grounding: "sources-only",
			};
		}
	} else if (!request.scope && request.folderPath) {
		const sources = await context.sources.listSources(context.projectId);
		const matchedDocIds: string[] = [];
		const normalizedFolder = request.folderPath.replace(/^\/+|\/+$/g, "");
		for (const source of sources) {
			const docs = await context.sources.listDocuments(source.id);
			for (const d of docs) {
				const docNorm = d.currentPath.replace(/^\/+/, "");
				if (docNorm.startsWith(normalizedFolder + "/") || docNorm === normalizedFolder) {
					matchedDocIds.push(d.id);
				}
			}
		}
		if (matchedDocIds.length > 0) {
			rawScope = {
				type: "document",
				projectId: context.projectId,
				documentIds: matchedDocIds,
				includePrerequisites: false,
				grounding: "sources-only",
			};
		}
	}

	// 2. Validate and resolve scope against ProjectContext
	const resolved = await validateAndResolveStudyScope(rawScope, context);

	// 3. Capture immutable graph snapshot
	const { snapshot, scopedNodes, scopedChains } = await captureScopedGraphSnapshot(context, resolved);

	// 4. Derive title
	let title = request.title?.trim();
	if (!title) {
		if (request.topic?.trim()) {
			title = `Study: ${request.topic.trim()}`;
		} else if (resolved.type === "document" && resolved.resolvedDocumentIds.length > 0) {
			title = `Study: ${resolved.resolvedDocumentIds.length} Note(s)`;
		} else if (resolved.type === "source" && resolved.resolvedSourceIds.length > 0) {
			title = `Study: ${resolved.resolvedSourceIds.length} Source(s)`;
		} else if (resolved.type === "proposition" && resolved.resolvedPropositionIds.length > 0) {
			title = `Study: ${resolved.resolvedPropositionIds.length} Concept(s)`;
		} else {
			title = "Study Session";
		}
	}

	// 5. Create chat record tagged with study scope
	const chat = context.chats.createChat(title, undefined, resolved.scope);

	// 6. Seed graph context message (immutable snapshot stored directly in message[0])
	const picks: GraphContextPick[] = scopedNodes.map((n) => ({
		id: n.id,
		name: n.name,
		statement: n.statement,
	}));
	const byId = Object.fromEntries(scopedNodes.map((n) => [n.id, n]));
	const chainLines = scopedChains.map((c) => formatChainLine(c, byId));

	const messages = [newGraphContextMessage(picks, chainLines)];
	context.chats.saveMessages(chat.id, messages);

	// 7. Synthesize initial prompt
	const mode = request.mode ?? "mixed";
	let initialPrompt = "";
	if (request.topic) {
		if (mode === "probe") {
			initialPrompt = `I would like to test and probe my understanding of "${request.topic}".`;
		} else if (mode === "teach") {
			initialPrompt = `Please teach and explain "${request.topic}" based on my notes.`;
		} else {
			initialPrompt = `Let's study "${request.topic}".`;
		}
	} else {
		if (mode === "probe") {
			initialPrompt = `I would like to probe my knowledge on the scoped topics.`;
		} else if (mode === "teach") {
			initialPrompt = `Please introduce and explain the key concepts in this scope.`;
		} else {
			initialPrompt = `Let's start studying the scoped notes and concepts.`;
		}
	}
	if (request.selection) {
		initialPrompt += `\n\nSelected text:\n> ${request.selection.split("\n").join("\n> ")}`;
	} else if (request.heading) {
		initialPrompt += `\n\nTarget section: ## ${request.heading}`;
	}
	if (request.customInstructions) {
		initialPrompt += `\n\nFocus: ${request.customInstructions}`;
	}

	return {
		sessionId: chat.id,
		projectId: context.projectId,
		scope: resolved.scope,
		initialPrompt,
		snapshot,
		createdAt: chat.createdAt,
		title: chat.title,
		mode,
	};
}
