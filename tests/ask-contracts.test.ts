/**
 * Ask Sources Contracts & Validation Tests (Milestone D Slice 3).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	validateAskSourcesRequest,
	validateAskSourcesResponse,
	InvalidAskQueryError,
	type AskSourcesRequest,
	type AskSourcesResponse,
	DEFAULT_TOP_K,
	MAX_TOP_K,
	DEFAULT_MIN_SCORE,
} from "../src/core/contracts/ask.ts";

describe("Suite 1: Ask Sources Request Contracts & Validation", () => {
	it("validates standard ask request with defaults", () => {
		const req = validateAskSourcesRequest({
			query: "quantum teleportation protocol",
		});
		assert.equal(req.query, "quantum teleportation protocol");
		assert.equal(req.topK, DEFAULT_TOP_K);
		assert.equal(req.minScore, DEFAULT_MIN_SCORE);
		assert.equal(req.synthesize, true);
		assert.equal(req.scope, undefined);
	});

	it("normalizes bridge request using question alias into query", () => {
		const req = validateAskSourcesRequest({
			question: "  how does entanglement work?  ",
			context: {
				filePath: "Physics/Quantum.md",
				selection: "entanglement",
			},
			vaultId: "vault-1",
		});
		assert.equal(req.query, "how does entanglement work?");
		assert.equal(req.context?.filePath, "Physics/Quantum.md");
		assert.equal(req.vaultId, "vault-1");
		assert.equal(req.synthesize, true);
	});

	it("prefers query over question if both are provided", () => {
		const req = validateAskSourcesRequest({
			query: "primary query",
			question: "secondary question",
		});
		assert.equal(req.query, "primary query");
	});

	it("validates explicit scope, topK, minScore, and syntaxFilters", () => {
		const req = validateAskSourcesRequest({
			query: "calculate Lagrangian",
			topK: 10,
			minScore: 1.5,
			synthesize: false,
			scope: {
				type: "project",
				projectId: "proj-1",
				grounding: "sources-only",
				includePrerequisites: false,
			},
			syntaxFilters: {
				hasEquation: true,
				hasCodeBlock: false,
			},
		});
		assert.equal(req.topK, 10);
		assert.equal(req.minScore, 1.5);
		assert.equal(req.synthesize, false);
		assert.equal(req.scope?.type, "project");
		assert.equal(req.syntaxFilters?.hasEquation, true);
	});

	it("rejects non-object or null request with InvalidAskQueryError (400)", () => {
		assert.throws(
			() => validateAskSourcesRequest(null),
			(err: unknown) => {
				assert(err instanceof InvalidAskQueryError);
				assert.equal(err.status, 400);
				return true;
			},
		);
		assert.throws(
			() => validateAskSourcesRequest("just a string"),
			(err: unknown) => {
				assert(err instanceof InvalidAskQueryError);
				assert.equal(err.status, 400);
				return true;
			},
		);
	});

	it("rejects empty or whitespace query with InvalidAskQueryError (400)", () => {
		assert.throws(
			() => validateAskSourcesRequest({ query: "" }),
			(err: unknown) => {
				assert(err instanceof InvalidAskQueryError);
				assert.equal(err.status, 400);
				assert.match(err.message, /Query cannot be empty/);
				return true;
			},
		);
		assert.throws(
			() => validateAskSourcesRequest({ query: "    \t \n  " }),
			(err: unknown) => {
				assert(err instanceof InvalidAskQueryError);
				assert.equal(err.status, 400);
				return true;
			},
		);
		assert.throws(
			() => validateAskSourcesRequest({}),
			(err: unknown) => {
				assert(err instanceof InvalidAskQueryError);
				assert.equal(err.status, 400);
				return true;
			},
		);
	});

	it("enforces topK bounds (1 <= topK <= MAX_TOP_K)", () => {
		assert.throws(
			() => validateAskSourcesRequest({ query: "test", topK: 0 }),
			(err: unknown) => {
				assert(err instanceof InvalidAskQueryError);
				assert.match(err.message, /topK must be >= 1/);
				return true;
			},
		);
		assert.throws(
			() => validateAskSourcesRequest({ query: "test", topK: MAX_TOP_K + 1 }),
			(err: unknown) => {
				assert(err instanceof InvalidAskQueryError);
				assert.match(err.message, /topK cannot exceed/);
				return true;
			},
		);
	});

	it("rejects negative minScore", () => {
		assert.throws(
			() => validateAskSourcesRequest({ query: "test", minScore: -0.5 }),
			(err: unknown) => {
				assert(err instanceof InvalidAskQueryError);
				assert.match(err.message, /minScore must be non-negative/);
				return true;
			},
		);
	});
});

describe("Suite 2: Ask Sources Response Contracts & Validation", () => {
	it("validates well-formed AskSourcesResponse", () => {
		const raw: AskSourcesResponse = {
			answer: "Entanglement is a physical phenomenon [1].",
			citations: [
				{
					sourceId: "src-1",
					sourceName: "Physics Notes",
					vaultId: "vault-1",
					vaultName: "Vault",
					documentId: "doc-1",
					documentPath: "Physics/Quantum.md",
					sectionHeading: "Entanglement",
					headingHierarchy: ["Quantum Mechanics", "Entanglement"],
					lineRange: { start: 10, end: 25 },
					characterRange: { startOffset: 120, endOffset: 340 },
					deepLink: "obsidian://open?vault=Vault&file=Physics%2FQuantum.md",
				},
			],
			scope: {
				type: "project",
				projectId: "proj-1",
				grounding: "sources-only",
				includePrerequisites: false,
			},
			grounded: true,
			retrievalStats: {
				totalCandidates: 12,
				searchDurationMs: 4.5,
				topScore: 3.2,
			},
		};

		const validated = validateAskSourcesResponse(raw);
		assert.equal(validated.answer, raw.answer);
		assert.equal(validated.grounded, true);
		assert.equal(validated.citations.length, 1);
		assert.equal(validated.citations[0]?.deepLink, raw.citations[0]?.deepLink);
		assert.equal(validated.retrievalStats?.totalCandidates, 12);
	});

	it("rejects response missing citations or grounded flag", () => {
		assert.throws(() =>
			validateAskSourcesResponse({
				answer: "some answer",
				scope: {
					type: "project",
					projectId: "proj-1",
					grounding: "sources-only",
					includePrerequisites: false,
				},
			}),
		);
	});
});
