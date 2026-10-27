/**
 * Grounded Answer Synthesis Engine (Milestone D Slice 3).
 *
 * Coordinates source-aware retrieval across Obsidian notes, builds grounded
 * prompts with exact citation markers [1], [2], calls the configured LLM engine,
 * and provides a deterministic, zero-hallucination Pure Synthesis Fallback when
 * no LLM API key is configured (zero-key state, offline mode, automated test suite).
 */

import { normalizeContext } from "@earendil-works/pi-ai";
import {
	type AskSourcesRequest,
	type AskSourcesResponse,
	type RetrievedSection,
	type SourceCitation,
	validateAskSourcesRequest,
	InvalidAskQueryError,
} from "../../core/contracts/index.ts";
import type { ProjectContext } from "../../core/contracts/project.ts";
import type { StudyScope } from "../../core/contracts/scope.ts";
import { piEngineForSpec, type PiEngine } from "../../agent/models.ts";
import { isSubscriptionProvider } from "../../agent/subscription-connections.ts";
import { resolveRoleSpec } from "../../core/settings-resolution.ts";
import { stores } from "../stores.ts";
import { providerKeyPresent } from "../keys.ts";
import { resolveProjectContext } from "../projects.ts";
import { retrieveSections, type RetrieveSectionsOptions } from "./ranker.ts";

export interface AskProjectSourcesOptions extends RetrieveSectionsOptions {
	/** Test seam: inject custom PiEngine */
	engine?: PiEngine;
	/** Cancellation signal */
	signal?: AbortSignal;
}

/**
 * Builds grounded synthesis prompt binding each source section to a numbered citation [1], [2], etc.
 */
export function buildGroundedSynthesisPrompt(
	query: string,
	sections: RetrievedSection[],
): { system: string; user: string } {
	const formattedSections = sections
		.map((s, idx) => {
			const num = idx + 1;
			const hierarchy =
				s.citation.headingHierarchy.length > 0
					? ` > ${s.citation.headingHierarchy.join(" > ")}`
					: "";
			const loc = `lines ${s.citation.lineRange.start}–${s.citation.lineRange.end}`;
			return `[Source ${num}]: ${s.citation.documentPath}${hierarchy} (${loc})\n${s.content}`;
		})
		.join("\n\n---\n\n");

	const system = [
		"You are LearnHarness's grounded question-answering assistant.",
		"Your objective is to provide a clear, accurate, and concise answer to the user's question, strictly grounded in the provided Obsidian note sources.",
		"",
		"Rules:",
		"1. Base your answer solely on the information provided in the sources.",
		"2. Cite your statements using bracketed numbers corresponding to the sources, e.g. [1], [2].",
		"3. Do not extrapolate, hallucinate, or bring in ungrounded external claims.",
		"4. If the provided sources do not contain enough information to completely answer the question, state what is known from the sources and note what is missing.",
		"5. Preserve LaTeX equations ($...$ or $$...$$) and code blocks exactly as formatted in the sources.",
	].join("\n");

	const user = `Sources:\n\n${formattedSections}\n\nQuestion: ${query}`;

	return { system, user };
}

/**
 * Deterministic Pure Synthesis Fallback.
 * Generates an extractive, structured answer directly from top retrieved sections with citations
 * when no LLM key is configured or offline mode is active.
 */
export function generatePureSynthesisFallback(
	query: string,
	sections: RetrievedSection[],
): string {
	const primary = sections[0];
	if (!primary) {
		return `No matching source sections found in your active study scope for "${query}".`;
	}

	const primaryTitle = primary.citation.sectionHeading ?? primary.citation.documentPath;
	const primaryLines = primary.content.trim().split("\n").filter(Boolean);
	const primaryExcerpt = primaryLines.slice(0, 5).join("\n> ");

	const lines = [
		`Based on **${primary.citation.documentPath}** (${primaryTitle}) [1]:`,
		"",
		`> ${primaryExcerpt}`,
	];

	const secondary = sections[1];
	if (secondary) {
		const secTitle = secondary.citation.sectionHeading ?? secondary.citation.documentPath;
		const secondaryLines = secondary.content.trim().split("\n").filter(Boolean);
		const secondaryExcerpt = secondaryLines.slice(0, 3).join("\n> ");
		lines.push(
			"",
			`Related context from **${secondary.citation.documentPath}** (${secTitle}) [2]:`,
			"",
			`> ${secondaryExcerpt}`,
		);
	}

	return lines.join("\n");
}

/**
 * Executes raw model synthesis via the configured PiEngine.
 */
export async function executeModelSynthesis(
	prompt: { system: string; user: string },
	engine: PiEngine,
	abortSignal?: AbortSignal,
): Promise<string> {
	const stream = engine.streamFn(
		engine.model,
		normalizeContext({
			systemPrompt: prompt.system,
			messages: [{ role: "user", content: prompt.user, timestamp: Date.now() }],
			tools: [],
		}),
		{
			reasoning: engine.level && engine.level !== "off" ? engine.level : undefined,
			signal: abortSignal,
		} as never,
	);

	for await (const event of stream) {
		if (event.type === "done") {
			const text = event.message.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("")
				.trim();
			return text;
		}
		if (event.type === "error") {
			if (event.reason === "aborted") {
				const err = new Error("aborted");
				err.name = "AbortError";
				throw err;
			}
			throw new Error(event.error.errorMessage ?? "the model call failed");
		}
	}

	throw new Error("the model stream ended without a result");
}

/**
 * Resolves effective StudyScope from request, inferring document scope from context.filePath if present.
 */
async function resolveRequestScope(
	context: ProjectContext,
	request: AskSourcesRequest,
): Promise<StudyScope | undefined> {
	if (request.scope) {
		return request.scope;
	}

	// Obsidian bridge context compatibility: infer document scope if filePath is provided
	if (request.context?.filePath) {
		const targetPath = request.context.filePath.trim().replace(/^\/+/, "");
		try {
			const sources = await context.sources.listSources(context.projectId);
			for (const source of sources) {
				if (!source.enabled) continue;
				if (request.vaultId && source.vaultId !== request.vaultId) continue;
				const docs = await context.sources.listDocuments(source.id);
				const matchedDoc = docs.find(
					(d) => d.currentPath.toLowerCase() === targetPath.toLowerCase(),
				);
				if (matchedDoc) {
					return {
						type: "document",
						projectId: context.projectId,
						sourceIds: [source.id],
						documentIds: [matchedDoc.id],
						grounding: "sources-only",
						includePrerequisites: false,
					};
				}
			}
		} catch {
			// Fall through to project-level scope
		}

		return {
			type: "project",
			projectId: context.projectId,
			grounding: "sources-only",
			includePrerequisites: false,
		};
	}

	return undefined;
}

/**
 * Executes grounded question answering against attached project sources and Obsidian notes.
 */
export async function askProjectSources(
	context: ProjectContext,
	rawRequest: unknown,
	options?: AskProjectSourcesOptions,
): Promise<AskSourcesResponse> {
	const request = validateAskSourcesRequest(rawRequest);

	// 1. Resolve effective StudyScope
	const scopeToUse = await resolveRequestScope(context, request);

	// 2. Perform Source-Aware Retrieval
	const retrieval = await retrieveSections(
		context,
		{
			query: request.query,
			scope: scopeToUse,
			topK: request.topK,
			minScore: request.minScore,
			syntaxFilters: request.syntaxFilters,
		},
		{
			dataDir: options?.dataDir,
			projectStore: options?.projectStore,
			vaultRegistry: options?.vaultRegistry,
			rankingOptions: options?.rankingOptions,
		},
	);

	const citations: SourceCitation[] = retrieval.sections.map((s) => s.citation);

	// 3. Evaluate Grounding Sufficiency
	if (retrieval.sections.length === 0) {
		return {
			answer: `I could not find any relevant information for "${request.query}" in the active study scope.`,
			citations: [],
			scope: retrieval.scope,
			grounded: false,
			retrievalStats: {
				totalCandidates: 0,
				searchDurationMs: retrieval.searchDurationMs,
			},
		};
	}

	// 4. If synthesis is not requested, return extractive citations directly
	if (request.synthesize === false) {
		const extractiveAnswer = generatePureSynthesisFallback(request.query, retrieval.sections);
		return {
			answer: extractiveAnswer,
			citations,
			scope: retrieval.scope,
			grounded: true,
			retrievalStats: {
				totalCandidates: retrieval.totalCandidates,
				searchDurationMs: retrieval.searchDurationMs,
				topScore: retrieval.sections[0]?.score,
			},
		};
	}

	// 5. Determine LLM Configuration
	let liveEngine: PiEngine | undefined = options?.engine;

	if (!liveEngine) {
		const settings = stores.settingsStore.readSettings();
		const spec = resolveRoleSpec("prober", settings) ?? resolveRoleSpec("teacher", settings);
		const hasLiveKey = spec
			? providerKeyPresent(spec.provider) || isSubscriptionProvider(spec.provider)
			: false;

		if (spec && hasLiveKey) {
			try {
				liveEngine = piEngineForSpec(spec, true);
			} catch {
				liveEngine = undefined;
			}
		}
	}

	// 6. Synthesis: Model execution or deterministic Pure Synthesis Fallback
	let answerText: string;
	if (liveEngine) {
		try {
			const prompt = buildGroundedSynthesisPrompt(request.query, retrieval.sections);
			answerText = await executeModelSynthesis(prompt, liveEngine, options?.signal);
		} catch {
			// Fallback to deterministic pure synthesis on model error/abort
			answerText = generatePureSynthesisFallback(request.query, retrieval.sections);
		}
	} else {
		// Zero-key / offline / test mode fallback
		answerText = generatePureSynthesisFallback(request.query, retrieval.sections);
	}

	return {
		answer: answerText,
		citations,
		scope: retrieval.scope,
		grounded: true,
		retrievalStats: {
			totalCandidates: retrieval.totalCandidates,
			searchDurationMs: retrieval.searchDurationMs,
			topScore: retrieval.sections[0]?.score,
		},
	};
}

/**
 * Convenience entry point resolving ProjectContext before running askProjectSources.
 */
export async function askSources(
	projectId: string,
	rawRequest: unknown,
	options?: AskProjectSourcesOptions,
): Promise<AskSourcesResponse> {
	const context = await resolveProjectContext(projectId, options);
	return askProjectSources(context, rawRequest, options);
}
