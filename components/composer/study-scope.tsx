"use client";

import React from "react";
import { FolderIcon, FileTextIcon, TagIcon, DumbbellIcon, GlobeIcon } from "lucide-react";
import type { StudyScope } from "@/src/core";
import { cn } from "@/lib/utils";

export interface StudyScopeIndicatorProps {
	scope?: StudyScope;
	onClick?: () => void;
	className?: string;
}

/**
 * Visual pill badge displaying the active retrieval scope for Ask Sources and Study sessions.
 */
export function StudyScopeIndicator({ scope, onClick, className }: StudyScopeIndicatorProps) {
	let label = "All Sources";
	let Icon = GlobeIcon;

	if (scope) {
		switch (scope.type) {
			case "source": {
				const count = scope.sourceIds?.length ?? 0;
				label = count === 1 ? "1 Source" : `${count} Sources`;
				Icon = FolderIcon;
				break;
			}
			case "document": {
				const count = scope.documentIds?.length ?? 0;
				label = count === 1 ? "1 Note" : `${count} Notes`;
				Icon = FileTextIcon;
				break;
			}
			case "tag": {
				const tags = scope.tagNames ?? scope.tags ?? [];
				const firstTag = tags[0];
				label = firstTag ? `#${firstTag.replace(/^#/, "")}` : "Tags";
				Icon = TagIcon;
				break;
			}
			case "proposition": {
				const count = scope.propositionIds?.length ?? 0;
				label = count === 1 ? "1 Node" : `${count} Nodes`;
				Icon = DumbbellIcon;
				break;
			}
			case "project":
			default:
				label = "All Sources";
				Icon = GlobeIcon;
				break;
		}
	}

	return (
		<button
			type="button"
			data-testid="study-scope-indicator"
			onClick={onClick}
			className={cn(
				"inline-flex items-center gap-1.5 rounded-full border border-border bg-card/80 px-2.5 py-1 font-ui text-xs text-foreground transition-colors hover:bg-accent cursor-pointer",
				className,
			)}
			aria-label={`Active study scope: ${label}`}
		>
			<Icon className="size-3 text-muted-foreground shrink-0" aria-hidden="true" />
			<span className="font-medium text-foreground">{label}</span>
		</button>
	);
}
