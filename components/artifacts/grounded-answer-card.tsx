"use client";

import React, { useState } from "react";
import { BookOpenIcon, ChevronDownIcon, ChevronUpIcon, SparklesIcon } from "lucide-react";
import type { AskSourcesResponse } from "@/src/core";
import { CitationBadge } from "../composer/citation-badge.tsx";
import { cn } from "@/lib/utils";

export interface GroundedAnswerCardProps {
	response: AskSourcesResponse;
	className?: string;
}

/**
 * Renders a grounded question-answering result with synthesized answer,
 * citations list, and grounding observability metrics.
 */
export function GroundedAnswerCard({ response, className }: GroundedAnswerCardProps) {
	const [expanded, setExpanded] = useState(true);
	const hasCitations = response.citations.length > 0;

	return (
		<div
			data-testid="grounded-answer-card"
			className={cn(
				"flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-xs",
				className,
			)}
		>
			<div className="flex items-center justify-between text-xs text-muted-foreground border-b border-border pb-2">
				<div className="flex items-center gap-1.5 font-medium text-foreground">
					<SparklesIcon className="size-3.5 text-primary" aria-hidden="true" />
					<span>Grounded in Obsidian Notes</span>
				</div>
				{response.retrievalStats && (
					<span data-testid="retrieval-duration" className="font-ui">
						{response.retrievalStats.totalCandidates} sources scanned in{" "}
						{response.retrievalStats.searchDurationMs}ms
					</span>
				)}
			</div>

			<div data-testid="grounded-answer-text" className="prose prose-sm dark:prose-invert max-w-none font-sans text-sm leading-relaxed text-foreground whitespace-pre-wrap">
				{response.answer}
			</div>

			{hasCitations && (
				<div className="mt-1 border-t border-border pt-2 flex flex-col gap-2">
					<button
						type="button"
						data-testid="citations-toggle-btn"
						onClick={() => setExpanded((prev) => !prev)}
						className="flex items-center justify-between font-ui text-xs text-muted-foreground hover:text-foreground cursor-pointer"
					>
						<span className="flex items-center gap-1.5 font-medium">
							<BookOpenIcon className="size-3" aria-hidden="true" />
							Sources & Citations ({response.citations.length})
						</span>
						{expanded ? (
							<ChevronUpIcon className="size-3.5" aria-hidden="true" />
						) : (
							<ChevronDownIcon className="size-3.5" aria-hidden="true" />
						)}
					</button>

					{expanded && (
						<div
							data-testid="grounded-answer-citations"
							className="flex flex-wrap items-center gap-2 pt-1"
						>
							{response.citations.map((c, idx) => (
								<CitationBadge
									key={`${c.sourceId}-${c.documentPath}-${idx}`}
									citation={c}
									index={idx + 1}
								/>
							))}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
