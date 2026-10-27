"use client";

/**
 * Proposition Open Note UI Component (Milestone B Slice 6).
 *
 * Renders an accessible deep-link button or link to open the original note in Obsidian
 * via the `obsidian://open` protocol. Optionally provides a secondary copy button.
 *
 * Adheres to:
 * - Layering boundaries: imports only from `@/src/core`, `lucide-react`, and `@/lib/utils`.
 * - SSR safety: no unhandled browser globals (`window`, `navigator`) during render.
 */

import React, { useCallback, useState } from "react";
import { CheckIcon, CopyIcon, ExternalLinkIcon } from "lucide-react";
import {
	createObsidianDeepLink,
	getNoteBasename,
	normalizeNotePath,
} from "@/src/core";
import { cn } from "@/lib/utils";

export interface PropositionOpenNoteProps {
	filePath: string;
	vaultName?: string;
	heading?: string;
	blockId?: string;
	variant?: "link" | "button" | "badge" | "icon";
	label?: string;
	showPath?: boolean;
	className?: string;
	showCopyButton?: boolean;
}

export function PropositionOpenNote({
	filePath,
	vaultName,
	heading,
	blockId,
	variant = "button",
	label,
	showPath = false,
	className,
	showCopyButton = false,
}: PropositionOpenNoteProps) {
	const [copied, setCopied] = useState(false);

	if (!filePath || typeof filePath !== "string" || !filePath.trim()) {
		return <span data-testid="open-note-disabled" className={className} />;
	}

	const cleanPath = normalizeNotePath(filePath);
	if (!cleanPath) {
		return <span data-testid="open-note-disabled" className={className} />;
	}

	const effectiveVault = vaultName?.trim() || "default";

	let uri = "";
	try {
		uri = createObsidianDeepLink({
			vaultName: effectiveVault,
			filePath: cleanPath,
			heading: heading?.trim() || undefined,
			blockId: blockId?.trim() || undefined,
		});
	} catch {
		return <span data-testid="open-note-disabled" className={className} />;
	}

	const handleCopy = useCallback(
		async (e: React.MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
				try {
					await navigator.clipboard.writeText(uri);
					setCopied(true);
					setTimeout(() => setCopied(false), 2000);
				} catch (err) {
					console.error("Failed to copy Obsidian deep link:", err);
				}
			}
		},
		[uri],
	);

	const titleText = `Open "${filePath}" in Obsidian${
		vaultName?.trim() ? ` (${vaultName.trim()})` : ""
	}`;
	const ariaLabelText = `Open note in Obsidian: ${filePath}`;

	const basename = getNoteBasename(filePath);
	const defaultLabel = showPath ? cleanPath : "Open in Obsidian";
	const displayLabel = label ?? defaultLabel;

	const linkContent = (
		<>
			<ExternalLinkIcon
				className={cn(
					"shrink-0",
					variant === "link" || variant === "badge" ? "size-3" : "size-3.5",
				)}
				aria-hidden="true"
			/>
			{variant !== "icon" && (
				<span className="truncate">
					{displayLabel}
					{label !== undefined && showPath && (
						<span className="ml-1 text-muted-foreground font-normal">
							({basename})
						</span>
					)}
				</span>
			)}
		</>
	);

	const variantClasses = {
		button:
			"inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-2.5 py-1 text-xs font-medium text-foreground shadow-xs transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring whitespace-nowrap",
		link:
			"inline-flex items-center gap-1 text-xs font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring whitespace-nowrap",
		badge:
			"inline-flex items-center gap-1 rounded-full border border-border/70 bg-muted/60 px-2.5 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring whitespace-nowrap",
		icon:
			"inline-flex items-center justify-center size-7 rounded-md border border-input bg-background text-muted-foreground shadow-xs transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring shrink-0",
	}[variant];

	const linkElement = (
		<a
			href={uri}
			data-testid="open-note-link"
			target="_blank"
			rel="noopener noreferrer"
			className={cn(variantClasses, !showCopyButton && className)}
			title={titleText}
			aria-label={ariaLabelText}
		>
			{linkContent}
		</a>
	);

	if (!showCopyButton) {
		return linkElement;
	}

	return (
		<div className={cn("inline-flex items-center gap-1.5", className)}>
			{linkElement}
			<button
				type="button"
				data-testid="open-note-copy"
				onClick={handleCopy}
				title={copied ? "Copied!" : "Copy Obsidian link"}
				aria-label="Copy Obsidian link"
				className="inline-flex size-7 items-center justify-center rounded-md border border-input bg-background text-muted-foreground shadow-xs transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring shrink-0"
			>
				{copied ? (
					<CheckIcon className="size-3.5 text-green-500 shrink-0" />
				) : (
					<CopyIcon className="size-3.5 shrink-0" />
				)}
				<span className="sr-only">{copied ? "Copied" : "Copy link"}</span>
			</button>
		</div>
	);
}
