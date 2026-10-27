/**
 * Server Retrieval & Ranking Engine.
 *
 * Implements candidate section assembly, multi-project boundary enforcement,
 * StudyScope filtering (project, source, document, tag, proposition + prerequisite DAGs),
 * Robertson-Spärck Jones BM25 scoring with structural Obsidian boosts, and exact
 * citation generation with Obsidian deep-links.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	DEFAULT_MIN_SCORE,
	DEFAULT_TOP_K,
	type RankingOptions,
	type RetrievedSection,
	type RetrievalResult,
	type SourceCitation,
	validateRetrievalQuery,
} from "../../core/contracts/retrieval.ts";
import type { ProjectContext } from "../../core/contracts/project.ts";
import type { ProjectStore, VaultRegistry } from "../../core/ports.ts";
import {
	calculateRobertsonSpärckJonesIdf,
	computeLineRange,
	escapeRegex,
	filterQueryTokens,
	generateMatchHighlights,
	tokenizeText,
} from "../../core/retrieval/scoring.ts";
import { parseObsidianMarkdown } from "../../core/obsidian/parser.ts";
import { chunkObsidianDocument } from "../../core/obsidian/chunker.ts";
import { createObsidianDeepLink } from "../../core/obsidian/deeplink.ts";
import { validateAndResolveStudyScope } from "../scope.ts";
import { resolveProjectContext } from "../projects.ts";
import { getVaultRegistry } from "../../store/vaults.ts";

/** Candidate section ready for ranking */
export interface CandidateSection {
	id: string;
	content: string;
	heading?: string;
	headingHierarchy: string[];
	documentPath: string;
	tokenEstimate: number;
	blockIds?: string[];
	tags?: string[];
	hasCodeBlock?: boolean;
	hasTable?: boolean;
	hasEquation?: boolean;
	citation: SourceCitation;
	isEvidenceGrounding?: boolean;
	tokens?: string[];
}

/**
 * Robertson-Spärck Jones BM25 Ranker with Obsidian Structural Boosts.
 */
export class SectionRanker {
	private readonly k1: number;
	private readonly b: number;
	private readonly headingBoost: number;
	private readonly ancestorHeadingBoost: number;
	private readonly pathBoost: number;
	private readonly exactPhraseBoost: number;
	private readonly propositionGroundingBoost: number;

	constructor(options?: RankingOptions) {
		this.k1 = options?.k1 ?? 1.2;
		this.b = options?.b ?? 0.75;
		this.headingBoost = options?.headingBoost ?? 2.5;
		this.ancestorHeadingBoost = options?.ancestorHeadingBoost ?? 1.5;
		this.pathBoost = options?.pathBoost ?? 1.8;
		this.exactPhraseBoost = options?.exactPhraseBoost ?? 1.5;
		this.propositionGroundingBoost = options?.propositionGroundingBoost ?? 1.5;
	}

	/**
	 * Scores and ranks candidate sections using BM25 and structural Obsidian boosts.
	 * Sub-millisecond performance across 1,000+ candidates.
	 */
	rank(
		candidates: CandidateSection[],
		query: string,
		topK = DEFAULT_TOP_K,
		minScore = DEFAULT_MIN_SCORE,
	): RetrievedSection[] {
		if (!candidates || candidates.length === 0 || !query || !query.trim()) {
			return [];
		}

		const rawTokens = tokenizeText(query);
		const queryTerms = filterQueryTokens(rawTokens);
		if (queryTerms.length === 0) return [];

		const queryTermSet = new Set(queryTerms);
		const N = candidates.length;
		const docTokensList: string[][] = new Array(N);
		let totalTokens = 0;

		// 1. Build Inverted Index & Token Structures for query terms
		const postingLists = new Map<
			string,
			Map<number, { tf: number; htf: number; atf: number; ptf: number }>
		>();
		for (const term of queryTerms) {
			postingLists.set(term, new Map());
		}

		for (let i = 0; i < N; i++) {
			const c = candidates[i]!;
			const cTokens = c.tokens ?? tokenizeText(c.content);
			docTokensList[i] = cTokens;
			totalTokens += cTokens.length;

			// Populate body postings via fast single-pass Set check
			for (let j = 0; j < cTokens.length; j++) {
				const t = cTokens[j]!;
				if (queryTermSet.has(t)) {
					const posting = postingLists.get(t)!;
					const entry = posting.get(i);
					if (entry) {
						entry.tf++;
					} else {
						posting.set(i, { tf: 1, htf: 0, atf: 0, ptf: 0 });
					}
				}
			}

			// Heading tokens
			if (c.heading) {
				const hTokens = tokenizeText(c.heading);
				for (let j = 0; j < hTokens.length; j++) {
					const t = hTokens[j]!;
					if (queryTermSet.has(t)) {
						const posting = postingLists.get(t)!;
						const entry = posting.get(i);
						if (entry) {
							entry.htf++;
						} else {
							posting.set(i, { tf: 0, htf: 1, atf: 0, ptf: 0 });
						}
					}
				}
			}

			// Ancestor tokens
			if (c.headingHierarchy && c.headingHierarchy.length > 0) {
				for (let h = 0; h < c.headingHierarchy.length; h++) {
					const aTokens = tokenizeText(c.headingHierarchy[h]!);
					for (let j = 0; j < aTokens.length; j++) {
						const t = aTokens[j]!;
						if (queryTermSet.has(t)) {
							const posting = postingLists.get(t)!;
							const entry = posting.get(i);
							if (entry) {
								entry.atf++;
							} else {
								posting.set(i, { tf: 0, htf: 0, atf: 1, ptf: 0 });
							}
						}
					}
				}
			}

			// Path tokens
			if (c.documentPath) {
				const pTokens = tokenizeText(c.documentPath);
				for (let j = 0; j < pTokens.length; j++) {
					const t = pTokens[j]!;
					if (queryTermSet.has(t)) {
						const posting = postingLists.get(t)!;
						const entry = posting.get(i);
						if (entry) {
							entry.ptf++;
						} else {
							posting.set(i, { tf: 0, htf: 0, atf: 0, ptf: 1 });
						}
					}
				}
			}
		}

		const avgdl = totalTokens / N || 1;
		const scores = new Float64Array(N);

		// 2. Accumulate BM25 Scores with Structural Term Weighting
		for (const term of queryTerms) {
			const posting = postingLists.get(term)!;
			const df = posting.size;
			if (df === 0) continue;

			// Robertson-Spärck Jones IDF
			const idf = calculateRobertsonSpärckJonesIdf(N, df);

			for (const [docIdx, counts] of posting) {
				const docLen = docTokensList[docIdx]!.length;
				const effectiveTf =
					counts.tf +
					counts.htf * this.headingBoost +
					counts.atf * this.ancestorHeadingBoost +
					counts.ptf * this.pathBoost;

				const num = effectiveTf * (this.k1 + 1);
				const denom = effectiveTf + this.k1 * (1 - this.b + this.b * (docLen / avgdl));
				const prev = scores[docIdx] ?? 0;
				scores[docIdx] = prev + idf * (num / denom);
			}
		}

		// 3. Exact Phrase & Grounding Multipliers
		const isMultiWord = queryTerms.length > 1;
		const phraseRegex = isMultiWord ? new RegExp(escapeRegex(query.trim()), "i") : null;

		const scoredIndices: Array<{ index: number; score: number }> = [];

		for (let i = 0; i < N; i++) {
			let score = scores[i]!;
			if (score <= minScore) continue;

			const c = candidates[i]!;

			// Exact phrase match boost
			if (phraseRegex) {
				if (c.heading && phraseRegex.test(c.heading)) {
					score *= this.exactPhraseBoost * 2.0; // 3.0x
				} else if (phraseRegex.test(c.content)) {
					score *= this.exactPhraseBoost;
				}
			}

			// Evidence grounding boost
			if (c.isEvidenceGrounding) {
				score *= this.propositionGroundingBoost;
			}

			scoredIndices.push({ index: i, score });
		}

		// 4. Sort and Slice Top-K
		scoredIndices.sort((a, b) => b.score - a.score);
		const topSlices = scoredIndices.slice(0, topK);

		return topSlices.map(({ index, score }) => {
			const c = candidates[index]!;
			const highlights = generateMatchHighlights(c.content, queryTerms);

			return {
				sectionId: c.id,
				content: c.content,
				score: Math.round(score * 1000) / 1000,
				matchHighlights: highlights,
				citation: c.citation,
				tokenEstimate: c.tokenEstimate,
				blockIds: c.blockIds,
				hasCodeBlock: c.hasCodeBlock,
				hasTable: c.hasTable,
				hasEquation: c.hasEquation,
			};
		});
	}
}

export interface RetrieveSectionsOptions {
	dataDir?: string;
	projectStore?: ProjectStore;
	vaultRegistry?: VaultRegistry;
	rankingOptions?: RankingOptions;
}

/**
 * Main server retrieval function:
 * 1. Validates and resolves StudyScope against the active ProjectContext.
 * 2. Discovers active project sources and validates vault bindings.
 * 3. Expands proposition prerequisites across knowledge graph chains if requested.
 * 4. Resolves notes, checks vault availability, and chunks Markdown sections.
 * 5. Applies syntax filters (hasCodeBlock, hasTable, hasEquation).
 * 6. Scores and ranks candidates using SectionRanker.
 * 7. Constructs exact citations with line numbers and Obsidian deep links.
 */
export async function retrieveSections(
	context: ProjectContext,
	rawQuery: unknown,
	options?: RetrieveSectionsOptions,
): Promise<RetrievalResult> {
	const startTime = performance.now();
	const query = validateRetrievalQuery(rawQuery);

	// 1. Resolve & Validate StudyScope
	const resolvedScope = await validateAndResolveStudyScope(query.scope, context);

	// 2. Discover Project Sources & Vault Registry
	const vRegistry = options?.vaultRegistry ?? getVaultRegistry(options?.dataDir);
	const projectSources = await context.sources.listSources(context.projectId);

	// Filter sources according to resolvedScope
	const activeSources = projectSources.filter((s) => {
		if (!s.enabled) return false;
		if (resolvedScope.type === "source") {
			return resolvedScope.resolvedSourceIds.includes(s.id);
		}
		return true;
	});

	// 3. Resolve Proposition & Prerequisite Evidence if scope is "proposition"
	const targetPropIds = new Set(resolvedScope.resolvedPropositionIds);
	if (
		resolvedScope.type === "proposition" &&
		resolvedScope.includePrerequisites &&
		typeof context.graph.readChains === "function"
	) {
		const chains = context.graph.readChains();
		const queue = [...targetPropIds];
		while (queue.length > 0) {
			const current = queue.shift()!;
			for (const chain of chains) {
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

	// Map of documentId -> Set of evidence locations for target propositions
	const evidenceLocationMap = new Map<
		string,
		Array<{ heading?: string; blockId?: string; startOffset?: number; endOffset?: number }>
	>();
	if (resolvedScope.type === "proposition") {
		for (const propId of targetPropIds) {
			const evList =
				typeof context.graph.getEvidenceForProposition === "function"
					? await context.graph.getEvidenceForProposition(propId)
					: [];
			for (const ev of evList) {
				if (ev.status === "active") {
					const list = evidenceLocationMap.get(ev.documentId) ?? [];
					list.push({
						heading: ev.heading ?? ev.location?.heading,
						blockId: ev.location?.blockId,
						startOffset: ev.range?.startOffset ?? ev.location?.startOffset,
						endOffset: ev.range?.endOffset ?? ev.location?.endOffset,
					});
					evidenceLocationMap.set(ev.documentId, list);
				}
			}
		}
	}

	// 4. Assemble Candidate Sections
	const candidates: CandidateSection[] = [];

	for (const source of activeSources) {
		const vault = await vRegistry.getVault(source.vaultId);
		if (!vault) continue;

		// Check available vault binding
		const binding = vault.bindings.find((b) => {
			try {
				return b.status === "available" && fs.existsSync(b.rootPath) && fs.statSync(b.rootPath).isDirectory();
			} catch {
				return false;
			}
		});
		if (!binding) continue; // Disconnected vault: skip safely without throwing

		const vaultRoot = path.resolve(binding.rootPath);
		const vaultName = vault.displayName?.trim() || vault.id;

		// List documents for this source
		const docs = await context.sources.listDocuments(source.id);

		for (const doc of docs) {
			if (doc.status !== "active") continue;

			// Filter by document scope
			if (resolvedScope.type === "document" && !resolvedScope.resolvedDocumentIds.includes(doc.id)) {
				continue;
			}

			// Filter by proposition scope: document must contain active evidence for target proposition(s)
			if (resolvedScope.type === "proposition" && !evidenceLocationMap.has(doc.id)) {
				continue;
			}

			const absPath = path.join(vaultRoot, doc.currentPath);
			if (!fs.existsSync(absPath)) continue;

			let rawContent: string;
			try {
				rawContent = await fs.promises.readFile(absPath, "utf-8");
			} catch {
				continue;
			}

			const parsedDoc = parseObsidianMarkdown(rawContent, doc.currentPath);

			// Filter by tag scope
			if (resolvedScope.type === "tag") {
				const matchesTag = resolvedScope.tagNames.some((tName) => {
					const cleanTName = tName.replace(/^#/, "").toLowerCase();
					return parsedDoc.tags.some((pt) => {
						const pLower = pt.name.replace(/^#/, "").toLowerCase();
						return pLower === cleanTName || pLower.startsWith(cleanTName + "/");
					});
				});
				if (!matchesTag) continue;
			}

			// Chunk document
			const chunks = chunkObsidianDocument(parsedDoc, rawContent, { maxTokens: 400 });

			for (const chunk of chunks) {
				// Apply syntax filters if specified
				if (query.syntaxFilters) {
					if (query.syntaxFilters.hasCodeBlock && !chunk.hasCodeBlock) continue;
					if (query.syntaxFilters.hasTable && !chunk.hasTable) continue;
					if (query.syntaxFilters.hasEquation && !chunk.hasEquation) continue;
				}

				// Compute 1-indexed line numbers
				const lineRange = computeLineRange(rawContent, chunk.range);

				// Generate Obsidian deep-link
				const primaryBlockId = chunk.blockIds?.[0];
				const deepLink = createObsidianDeepLink({
					vaultName,
					filePath: doc.currentPath,
					heading: chunk.heading,
					blockId: primaryBlockId,
				});

				const citation: SourceCitation = {
					sourceId: source.id,
					sourceName: source.id,
					vaultId: vault.id,
					vaultName,
					documentId: doc.id,
					documentPath: doc.currentPath,
					sectionHeading: chunk.heading,
					headingHierarchy: [...chunk.headingHierarchy],
					lineRange,
					characterRange: {
						startOffset: chunk.range.startOffset,
						endOffset: chunk.range.endOffset,
					},
					deepLink,
					blockId: primaryBlockId,
					revisionId: doc.revisionId,
					contentHash: doc.contentHash,
				};

				// Determine if chunk matches evidence location for proposition grounding
				let isEvidenceGrounding = false;
				if (resolvedScope.type === "proposition") {
					const docEvidenceLocs = evidenceLocationMap.get(doc.id) ?? [];
					for (const loc of docEvidenceLocs) {
						if (loc.heading && loc.heading === chunk.heading) {
							isEvidenceGrounding = true;
							break;
						}
						if (
							loc.startOffset !== undefined &&
							loc.endOffset !== undefined &&
							chunk.range.startOffset <= loc.startOffset &&
							chunk.range.endOffset >= loc.endOffset
						) {
							isEvidenceGrounding = true;
							break;
						}
					}
				}

				candidates.push({
					id: chunk.id,
					content: chunk.content,
					heading: chunk.heading,
					headingHierarchy: chunk.headingHierarchy,
					documentPath: doc.currentPath,
					tokenEstimate: chunk.tokenEstimate,
					blockIds: chunk.blockIds,
					hasCodeBlock: chunk.hasCodeBlock,
					hasTable: chunk.hasTable,
					hasEquation: chunk.hasEquation,
					citation,
					isEvidenceGrounding,
					tokens: tokenizeText(chunk.content),
				});
			}
		}
	}

	// 5. Rank Candidates
	const ranker = new SectionRanker(options?.rankingOptions);
	const rankedSections = ranker.rank(candidates, query.query, query.topK, query.minScore);
	const durationMs = Math.round((performance.now() - startTime) * 100) / 100;

	return {
		sections: rankedSections,
		totalCandidates: candidates.length,
		searchDurationMs: durationMs,
		query: query.query,
		scope: resolvedScope.scope,
	};
}

/**
 * Convenience entry point resolving ProjectContext before running retrieveSections.
 */
export async function retrieveProjectSections(
	projectId: string,
	rawQuery: unknown,
	options?: RetrieveSectionsOptions,
): Promise<RetrievalResult> {
	const context = await resolveProjectContext(projectId, options);
	return retrieveSections(context, rawQuery, options);
}
