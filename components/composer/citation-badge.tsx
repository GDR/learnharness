"use client";

import React, { useState, useCallback } from "react";
import { ExternalLinkIcon, CheckIcon, CopyIcon, BookOpenIcon, AlertTriangleIcon } from "lucide-react";
import type { SourceCitation } from "@/src/core";
import { cn } from "@/lib/utils";

export interface CitationBadgeProps {
	citation: SourceCitation;
	index?: number;
	vaultStatus?: "available" | "unavailable";
	className?: string;
	onOpen?: (citation: SourceCitation) => void;
}

/**
 * Clickable citation badge linking to an Obsidian note section via obsidian:// URI.
 * Includes line ranges, heading provenance, copy button, and vault availability status.
 */
export function CitationBadge({
	citation,
	index,
	vaultStatus = "available",
	className,
	onOpen,
}: CitationBadgeProps) {
	const [copied, setCopied] = useState(false);
	const isUnavailable = vaultStatus === "unavailable";

	const handleCopy = useCallback(
		async (e: React.MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
				try {
					await navigator.clipboard.writeText(citation.deepLink);
					setCopied(true);
					setTimeout(() => setCopied(false), 2000);
				} catch {
					// Fallback safely if clipboard write fails
				}
			}
		},
		[citation.deepLink],
	);

	const loc = `L${citation.lineRange.start}–${citation.lineRange.end}`;
	const label = citation.sectionHeading
		? `${citation.documentPath} > ${citation.sectionHeading} (${loc})`
		: `${citation.documentPath} (${loc})`;

	return (
		<div
			data-testid="citation-badge"
			className={cn(
				"inline-flex items-center gap-1.5 rounded-md border border-border bg-card/80 px-2 py-1 font-ui text-xs text-foreground transition-colors hover:bg-accent",
				isUnavailable && "opacity-60 border-destructive/40",
				className,
			)}
		>
			{index !== undefined && (
				<span data-testid="citation-index" className="font-semibold text-primary">
					[{index}]
				</span>
			)}
			<BookOpenIcon className="size-3 text-muted-foreground shrink-0" aria-hidden="true" />
			<a
				href={citation.deepLink}
				target="_blank"
				rel="noopener noreferrer"
				aria-label={`Open ${citation.documentPath} in Obsidian`}
				className="truncate hover:underline max-w-[240px]"
				onClick={() => onOpen?.(citation)}
			>
				{label}
			</a>
			{isUnavailable ? (
				<span
					data-testid="citation-unavailable-warning"
					title="Vault is currently disconnected or unavailable"
					className="text-amber-500"
				>
					<AlertTriangleIcon className="size-3 shrink-0" aria-label="Vault unavailable" />
				</span>
			) : (
				<ExternalLinkIcon className="size-3 text-muted-foreground shrink-0" aria-hidden="true" />
			)}
			<button
				type="button"
				data-testid="citation-copy-btn"
				title="Copy Obsidian link"
				aria-label="Copy Obsidian link"
				onClick={handleCopy}
				className="ml-1 text-muted-foreground hover:text-foreground cursor-pointer"
			>
				{copied ? (
					<CheckIcon data-testid="citation-copied-icon" className="size-3 text-green-500" />
				) : (
					<CopyIcon className="size-3" />
				)}
			</button>
		</div>
	);
}
