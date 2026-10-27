/**
 * Render & SSR Unit Tests: Proposition Open Note UI (Milestone B Slice 6).
 *
 * Verifies:
 * 1. PropositionOpenNote SSR markup, test IDs, attributes, labels, variants, and copy button.
 * 2. Generated obsidian:// URI structures (vault, note path, heading, blockId).
 * 3. Unicode and Cyrillic encoding in URIs and accessible titles.
 * 4. Graceful handling of invalid or empty file paths.
 * 5. Integration in GraphView / GraphNodeInspectorCard and GraphChromeRow.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
	PropositionOpenNote,
	type PropositionOpenNoteProps,
} from "../components/proposition-open-note.tsx";
import {
	GraphChromeRow,
	GraphNodeInspectorCard,
	GraphView,
	type Selection,
} from "../components/graph-view.tsx";
import type { GraphNode, GraphSnapshot } from "../src/core/index.ts";
import type { GraphRenderSettings } from "../components/graph-canvas.ts";

describe("PropositionOpenNote Component", () => {
	it("renders default button link with obsidian://open URI and accessible attributes", () => {
		const html = renderToStaticMarkup(
			<PropositionOpenNote filePath="Physics/Classical Mechanics.md" />,
		);

		assert.ok(html.includes('data-testid="open-note-link"'));
		assert.ok(
			html.includes(
				'href="obsidian://open?vault=default&amp;file=Physics%2FClassical%20Mechanics"',
			),
		);
		assert.ok(html.includes('target="_blank"'));
		assert.ok(html.includes('rel="noopener noreferrer"'));
		assert.ok(
			html.includes(
				'title="Open &quot;Physics/Classical Mechanics.md&quot; in Obsidian"',
			),
		);
		assert.ok(
			html.includes(
				'aria-label="Open note in Obsidian: Physics/Classical Mechanics.md"',
			),
		);
		assert.ok(html.includes("Open in Obsidian"));
		assert.ok(html.includes("lucide-external-link"));
	});

	it("uses explicit vaultName in URI and title", () => {
		const html = renderToStaticMarkup(
			<PropositionOpenNote
				filePath="Chemistry/Reactions.md"
				vaultName="Research Lab"
			/>,
		);

		assert.ok(
			html.includes(
				'href="obsidian://open?vault=Research%20Lab&amp;file=Chemistry%2FReactions"',
			),
		);
		assert.ok(
			html.includes(
				'title="Open &quot;Chemistry/Reactions.md&quot; in Obsidian (Research Lab)"',
			),
		);
	});

	it("appends section heading anchor (#heading)", () => {
		const html1 = renderToStaticMarkup(
			<PropositionOpenNote
				filePath="Biology/Genetics.md"
				heading="CRISPR Mechanisms"
			/>,
		);
		assert.ok(
			html1.includes(
				'href="obsidian://open?vault=default&amp;file=Biology%2FGenetics#CRISPR%20Mechanisms"',
			),
		);

		// Leading # should be trimmed safely
		const html2 = renderToStaticMarkup(
			<PropositionOpenNote
				filePath="Biology/Genetics.md"
				heading="#Cell Division"
			/>,
		);
		assert.ok(
			html2.includes(
				'href="obsidian://open?vault=default&amp;file=Biology%2FGenetics#Cell%20Division"',
			),
		);
	});

	it("appends block reference anchor (#^blockId)", () => {
		const html1 = renderToStaticMarkup(
			<PropositionOpenNote
				filePath="Math/Theorems.md"
				blockId="euler-identity"
			/>,
		);
		assert.ok(
			html1.includes(
				'href="obsidian://open?vault=default&amp;file=Math%2FTheorems#^euler-identity"',
			),
		);

		// Leading ^ should be trimmed safely
		const html2 = renderToStaticMarkup(
			<PropositionOpenNote
				filePath="Math/Theorems.md"
				blockId="^pythagoras"
			/>,
		);
		assert.ok(
			html2.includes(
				'href="obsidian://open?vault=default&amp;file=Math%2FTheorems#^pythagoras"',
			),
		);
	});

	it("supports custom label and showPath toggle", () => {
		const htmlCustom = renderToStaticMarkup(
			<PropositionOpenNote
				filePath="Notes/Index.md"
				label="Jump to Note"
			/>,
		);
		assert.ok(htmlCustom.includes("Jump to Note"));
		assert.ok(!htmlCustom.includes("Open in Obsidian"));

		const htmlPath = renderToStaticMarkup(
			<PropositionOpenNote
				filePath="Deep/Nested/Structure/Note.md"
				showPath={true}
			/>,
		);
		assert.ok(htmlPath.includes("Deep/Nested/Structure/Note"));

		const htmlBoth = renderToStaticMarkup(
			<PropositionOpenNote
				filePath="Deep/Nested/Structure/Note.md"
				label="Source Note"
				showPath={true}
			/>,
		);
		assert.ok(htmlBoth.includes("Source Note"));
		assert.ok(htmlBoth.includes("(Note)"));
	});

	it("renders all four variants: button, link, badge, icon", () => {
		const htmlButton = renderToStaticMarkup(
			<PropositionOpenNote filePath="note.md" variant="button" />,
		);
		assert.ok(htmlButton.includes("border-input"));
		assert.ok(htmlButton.includes("Open in Obsidian"));

		const htmlLink = renderToStaticMarkup(
			<PropositionOpenNote filePath="note.md" variant="link" />,
		);
		assert.ok(htmlLink.includes("hover:underline"));
		assert.ok(htmlLink.includes("text-primary"));

		const htmlBadge = renderToStaticMarkup(
			<PropositionOpenNote filePath="note.md" variant="badge" />,
		);
		assert.ok(htmlBadge.includes("rounded-full"));
		assert.ok(htmlBadge.includes("bg-muted/60"));

		const htmlIcon = renderToStaticMarkup(
			<PropositionOpenNote filePath="note.md" variant="icon" />,
		);
		assert.ok(htmlIcon.includes("size-7"));
		assert.ok(!htmlIcon.includes("Open in Obsidian"));
	});

	it("renders secondary copy button when showCopyButton is enabled", () => {
		const htmlWithCopy = renderToStaticMarkup(
			<PropositionOpenNote filePath="note.md" showCopyButton={true} />,
		);
		assert.ok(htmlWithCopy.includes('data-testid="open-note-copy"'));
		assert.ok(htmlWithCopy.includes("lucide-copy"));
		assert.ok(htmlWithCopy.includes('aria-label="Copy Obsidian link"'));

		const htmlWithoutCopy = renderToStaticMarkup(
			<PropositionOpenNote filePath="note.md" showCopyButton={false} />,
		);
		assert.ok(!htmlWithoutCopy.includes('data-testid="open-note-copy"'));
	});

	it("gracefully renders disabled fallback on empty or invalid filePath", () => {
		const htmlEmpty = renderToStaticMarkup(<PropositionOpenNote filePath="" />);
		assert.ok(htmlEmpty.includes('data-testid="open-note-disabled"'));
		assert.ok(!htmlEmpty.includes('data-testid="open-note-link"'));

		const htmlSpaces = renderToStaticMarkup(
			<PropositionOpenNote filePath="    " />,
		);
		assert.ok(htmlSpaces.includes('data-testid="open-note-disabled"'));
		assert.ok(!htmlSpaces.includes('data-testid="open-note-link"'));

		const htmlSlashes = renderToStaticMarkup(
			<PropositionOpenNote filePath="///" />,
		);
		assert.ok(htmlSlashes.includes('data-testid="open-note-disabled"'));
		assert.ok(!htmlSlashes.includes('data-testid="open-note-link"'));
	});

	it("properly encodes Unicode / Cyrillic filenames, vaults, and headings", () => {
		const html = renderToStaticMarkup(
			<PropositionOpenNote
				filePath="Квантовая механика/Волновая функция.md"
				vaultName="Наука & Физика"
				heading="Уравнение Шрёдингера"
			/>,
		);

		assert.ok(
			html.includes(
				'title="Open &quot;Квантовая механика/Волновая функция.md&quot; in Obsidian (Наука &amp; Физика)"',
			),
		);
	});

	it("normalizes path slashes and extensions seamlessly", () => {
		const htmlBackslashes = renderToStaticMarkup(
			<PropositionOpenNote filePath={"Windows\\Path\\Note.md"} />,
		);
		assert.ok(
			htmlBackslashes.includes("file=Windows%2FPath%2FNote"),
		);

		const htmlRel = renderToStaticMarkup(
			<PropositionOpenNote filePath="./Relative/Path.mdx" />,
		);
		assert.ok(
			htmlRel.includes("file=Relative%2FPath"),
		);

		const htmlNoExt = renderToStaticMarkup(
			<PropositionOpenNote filePath="/LeadingSlash/PlainNote" />,
		);
		assert.ok(
			htmlNoExt.includes("file=LeadingSlash%2FPlainNote"),
		);
	});

	it("trims vaultName and heading whitespaces", () => {
		const html = renderToStaticMarkup(
			<PropositionOpenNote
				filePath="Notes/Physics.md"
				vaultName="   Trimmed Vault   "
				heading="   Summary Section   "
			/>,
		);
		assert.ok(html.includes("vault=Trimmed%20Vault"));
		assert.ok(html.includes("#Summary%20Section"));
		assert.ok(html.includes("(Trimmed Vault)"));
	});
});

import { ServerEventsProvider, type NotifySource } from "../components/server-events.tsx";

describe("GraphNodeInspectorCard & GraphView Integration", () => {
	const mockNode: GraphNode = {
		id: "prop_1",
		name: "Schrödinger Equation",
		statement: "Linear partial differential equation governing the wave function.",
		aliases: ["Wave mechanics equation"],
		createdAt: "2026-10-27T00:00:00.000Z",
		provenance: [{ chatId: "chat_1", messageId: "msg_1" }],
	};

	const mockSnapshot: GraphSnapshot = {
		nodes: [mockNode],
		propositions: [mockNode],
		edges: [],
		logicalEdges: [],
		impLinks: [],
		chains: [],
		clusters: [{ id: "c_quantum", label: "Quantum Mechanics", members: ["prop_1"] }],
		sessions: { chat_1: "Tutoring Session 1" },
		fileSources: {
			src_obsidian_1: "Vaults/Physics/Quantum Mechanics.md",
		},
		nodeSessions: { prop_1: ["chat_1"] },
	};

	const mockSelection: Selection = {
		node: mockNode,
		sourceIds: ["chat_1", "src_obsidian_1"],
		anchor: { x: 100, y: 150 },
	};

	it("renders inspector card with both chat link and Obsidian note deep link", () => {
		const html = renderToStaticMarkup(
			<GraphNodeInspectorCard
				selected={mockSelection}
				snapshot={mockSnapshot}
			/>,
		);

		assert.ok(html.includes('data-testid="graph-node-inspector"'));
		assert.ok(html.includes("Schrödinger Equation"));
		assert.ok(html.includes("Tutoring Session 1"));
		assert.ok(html.includes("Vaults/Physics/Quantum Mechanics.md"));

		// Must render PropositionOpenNote button
		assert.ok(html.includes('data-testid="open-note-link"'));
		assert.ok(
			html.includes(
				'href="obsidian://open?vault=default&amp;file=Vaults%2FPhysics%2FQuantum%20Mechanics"',
			),
		);
	});

	it("renders fallback message when node has no recorded sources", () => {
		const emptySelection: Selection = {
			node: mockNode,
			sourceIds: [],
			anchor: { x: 50, y: 50 },
		};

		const html = renderToStaticMarkup(
			<GraphNodeInspectorCard
				selected={emptySelection}
				snapshot={mockSnapshot}
			/>,
		);

		assert.ok(html.includes("No sessions recorded."));
		assert.ok(!html.includes('data-testid="open-note-link"'));
	});

	it("renders multiple file sources with independent Open in Obsidian buttons", () => {
		const multiSnapshot: GraphSnapshot = {
			...mockSnapshot,
			fileSources: {
				src_1: "Math/Linear Algebra.md",
				src_2: "Physics/Quantum Mechanics.md",
			},
		};

		const multiSelection: Selection = {
			node: mockNode,
			sourceIds: ["src_1", "src_2"],
			anchor: { x: 100, y: 100 },
		};

		const html = renderToStaticMarkup(
			<GraphNodeInspectorCard
				selected={multiSelection}
				snapshot={multiSnapshot}
			/>,
		);

		assert.ok(html.includes("Math/Linear Algebra.md"));
		assert.ok(html.includes("Physics/Quantum Mechanics.md"));
		assert.ok(html.includes("file=Math%2FLinear%20Algebra"));
		assert.ok(html.includes("file=Physics%2FQuantum%20Mechanics"));

		// 2 links rendered
		const linkCount = (html.match(/data-testid="open-note-link"/g) || []).length;
		assert.equal(linkCount, 2);
	});

	it("renders GraphChromeRow properly without regressions", () => {
		const ref = { current: null };
		const props = {
			query: "",
			onQuery: () => {},
			noMatch: false,
			importing: false,
			searchInputRef: ref,
			fileInputRef: ref,
			onImportFiles: () => {},
			settings: {} as GraphRenderSettings,
			changeSettings: () => {},
			onOpenChains: () => {},
		};

		const emptyHtml = renderToStaticMarkup(
			<GraphChromeRow {...props} isEmpty={true} />,
		);
		assert.ok(emptyHtml.includes('data-testid="import-notes"'));
		assert.ok(!emptyHtml.includes("Search nodes…"));

		const populatedHtml = renderToStaticMarkup(
			<GraphChromeRow {...props} isEmpty={false} />,
		);
		assert.ok(populatedHtml.includes('data-testid="import-notes"'));
		assert.ok(populatedHtml.includes("Search nodes…"));
	});

	it("renders GraphView safely under SSR without throwing", () => {
		const mockConnect = (): NotifySource => ({
			close: () => {},
			onOpen: () => {},
			onEvent: () => {},
		});

		const html = renderToStaticMarkup(
			<ServerEventsProvider connect={mockConnect}>
				<GraphView />
			</ServerEventsProvider>,
		);
		assert.ok(typeof html === "string");
		assert.ok(html.includes("Knowledge graph"));
		assert.ok(html.includes('data-testid="import-notes"'));
	});
});
