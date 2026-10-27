/**
 * UI & Render Tests for Milestone D Slice 3: Citation Badges, StudyScope, and Chat Composer.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CitationBadge } from "../components/composer/citation-badge.tsx";
import { StudyScopeIndicator } from "../components/composer/study-scope.tsx";
import { ComposerModeToggle } from "../components/composer-actions.tsx";
import { ChatComposer } from "../components/chat/chat-composer.tsx";
import { GroundedAnswerCard } from "../components/artifacts/grounded-answer-card.tsx";
import type { SourceCitation, AskSourcesResponse } from "../src/core/index.ts";

const mockCitation: SourceCitation = {
	sourceId: "src_1",
	sourceName: "Physics Notes",
	vaultId: "vault_1",
	vaultName: "QuantumVault",
	documentId: "doc_1",
	documentPath: "Physics/Quantum/Entanglement.md",
	sectionHeading: "EPR Paradox",
	headingHierarchy: ["Quantum Mechanics", "EPR Paradox"],
	lineRange: { start: 15, end: 30 },
	characterRange: { startOffset: 200, endOffset: 500 },
	deepLink: "obsidian://open?vault=QuantumVault&file=Physics%2FQuantum%2FEntanglement",
};

describe("Suite 1: CitationBadge Component", () => {
	it("renders clickable citation badge with obsidian:// deep-link", () => {
		const html = renderToStaticMarkup(
			<CitationBadge citation={mockCitation} index={1} />,
		);

		assert.ok(html.includes('data-testid="citation-badge"'));
		assert.ok(html.includes('data-testid="citation-index"'));
		assert.ok(html.includes("[1]"));
		assert.ok(
			html.includes(
				'href="obsidian://open?vault=QuantumVault&amp;file=Physics%2FQuantum%2FEntanglement"',
			),
		);
		assert.ok(html.includes("Physics/Quantum/Entanglement.md &gt; EPR Paradox (L15–30)"));
		assert.ok(html.includes('data-testid="citation-copy-btn"'));
		assert.ok(!html.includes('data-testid="citation-unavailable-warning"'));
	});

	it("renders warning indicator when vault status is unavailable", () => {
		const html = renderToStaticMarkup(
			<CitationBadge citation={mockCitation} vaultStatus="unavailable" />,
		);

		assert.ok(html.includes('data-testid="citation-unavailable-warning"'));
		assert.ok(html.includes("opacity-60"));
	});
});

describe("Suite 2: StudyScopeIndicator Component", () => {
	it("renders 'All Sources' by default or for project scope", () => {
		const htmlDefault = renderToStaticMarkup(<StudyScopeIndicator />);
		assert.ok(htmlDefault.includes("All Sources"));

		const htmlProject = renderToStaticMarkup(
			<StudyScopeIndicator
				scope={{ type: "project", projectId: "p1", grounding: "sources-only" }}
			/>,
		);
		assert.ok(htmlProject.includes("All Sources"));
	});

	it("renders singular and plural notes for document scope", () => {
		const html1 = renderToStaticMarkup(
			<StudyScopeIndicator
				scope={{ type: "document", projectId: "p1", documentIds: ["d1"] }}
			/>,
		);
		assert.ok(html1.includes("1 Note"));

		const html2 = renderToStaticMarkup(
			<StudyScopeIndicator
				scope={{ type: "document", projectId: "p1", documentIds: ["d1", "d2"] }}
			/>,
		);
		assert.ok(html2.includes("2 Notes"));
	});

	it("renders tag name for tag scope", () => {
		const htmlTag = renderToStaticMarkup(
			<StudyScopeIndicator
				scope={{ type: "tag", projectId: "p1", tagNames: ["#quantum/decoherence"] }}
			/>,
		);
		assert.ok(htmlTag.includes("#quantum/decoherence"));
	});

	it("renders node counts for proposition scope", () => {
		const htmlProps = renderToStaticMarkup(
			<StudyScopeIndicator
				scope={{ type: "proposition", projectId: "p1", propositionIds: ["n1", "n2", "n3"] }}
			/>,
		);
		assert.ok(htmlProps.includes("3 Nodes"));
	});
});

describe("Suite 3: ComposerModeToggle Component", () => {
	it("renders Chat and Ask Sources buttons with active styling", () => {
		const htmlChat = renderToStaticMarkup(<ComposerModeToggle mode="chat" />);
		assert.ok(htmlChat.includes('data-testid="composer-mode-chat"'));
		assert.ok(htmlChat.includes('data-testid="composer-mode-ask"'));
		assert.ok(htmlChat.includes("Chat"));
		assert.ok(htmlChat.includes("Ask Sources"));

		const htmlAsk = renderToStaticMarkup(<ComposerModeToggle mode="ask" />);
		assert.ok(htmlAsk.includes('data-testid="composer-mode-toggle"'));
	});
});

describe("Suite 4: ChatComposer Integration", () => {
	it("renders integrated composer in Chat mode", () => {
		const html = renderToStaticMarkup(
			<ChatComposer
				busy={false}
				value=""
				onChange={() => {}}
				onSend={() => {}}
				onStop={() => {}}
				canSend={false}
				mode="chat"
			/>,
		);

		assert.ok(html.includes('data-testid="chat-composer"'));
		assert.ok(html.includes('data-testid="composer"'));
		assert.ok(html.includes("Ask, answer, or steer the lesson"));
		assert.ok(!html.includes('data-testid="study-scope-indicator"'));
	});

	it("renders Ask mode with scope indicator and custom placeholder", () => {
		const html = renderToStaticMarkup(
			<ChatComposer
				busy={false}
				value=""
				onChange={() => {}}
				onSend={() => {}}
				onStop={() => {}}
				canSend={false}
				mode="ask"
				scope={{ type: "document", projectId: "p1", documentIds: ["d1"] }}
			/>,
		);

		assert.ok(html.includes('data-testid="chat-composer"'));
		assert.ok(html.includes('data-testid="study-scope-indicator"'));
		assert.ok(html.includes("1 Note"));
		assert.ok(html.includes("Ask a question grounded in your Obsidian notes"));
	});

	it("renders citations list below composer when citations are present", () => {
		const html = renderToStaticMarkup(
			<ChatComposer
				busy={false}
				value=""
				onChange={() => {}}
				onSend={() => {}}
				onStop={() => {}}
				canSend={false}
				mode="ask"
				citations={[mockCitation]}
			/>,
		);

		assert.ok(html.includes('data-testid="chat-composer-citations"'));
		assert.ok(html.includes('data-testid="citation-badge"'));
		assert.ok(html.includes("EPR Paradox"));
	});
});

describe("Suite 5: GroundedAnswerCard Component", () => {
	it("renders answer text, citations, and retrieval stats", () => {
		const response: AskSourcesResponse = {
			answer: "Grounded answer explaining quantum mechanics [1].",
			citations: [mockCitation],
			scope: { type: "project", projectId: "p1", grounding: "sources-only" },
			grounded: true,
			retrievalStats: {
				totalCandidates: 8,
				searchDurationMs: 6.4,
			},
		};

		const html = renderToStaticMarkup(<GroundedAnswerCard response={response} />);

		assert.ok(html.includes('data-testid="grounded-answer-card"'));
		assert.ok(html.includes("Grounded in Obsidian Notes"));
		assert.ok(html.includes('data-testid="retrieval-duration"'));
		assert.ok(html.includes("8 sources scanned in 6.4ms"));
		assert.ok(html.includes("Grounded answer explaining quantum mechanics [1]."));
		assert.ok(html.includes('data-testid="citations-toggle-btn"'));
		assert.ok(html.includes("Sources &amp; Citations (1)"));
		assert.ok(html.includes('data-testid="grounded-answer-citations"'));
		assert.ok(html.includes('data-testid="citation-badge"'));
	});
});
