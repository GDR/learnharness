"use client";

import React from "react";
import { AlertTriangleIcon, FileDiffIcon, Trash2Icon, WifiOffIcon } from "lucide-react";
import type { DocumentWarningStatus } from "@/src/core";
import { cn } from "@/lib/utils";

export interface DocumentStatusBadgeProps {
	status: DocumentWarningStatus;
	message?: string;
	className?: string;
	deepLink?: string;
}

export function DocumentStatusBadge({ status, message, className, deepLink }: DocumentStatusBadgeProps) {
	if (status === "current") return null;

	const config = {
		modified: {
			label: "Modified",
			Icon: AlertTriangleIcon,
			style: "bg-amber-500/15 text-amber-500 border-amber-500/30",
		},
		moved: {
			label: "Moved",
			Icon: FileDiffIcon,
			style: "bg-blue-500/15 text-blue-500 border-blue-500/30",
		},
		deleted: {
			label: "Deleted Note",
			Icon: Trash2Icon,
			style: "bg-red-500/15 text-red-500 border-red-500/30",
		},
		unavailable: {
			label: "Vault Offline",
			Icon: WifiOffIcon,
			style: "bg-orange-500/15 text-orange-500 border-orange-500/30",
		},
	}[status];

	if (!config) return null;
	const { label, Icon, style } = config;

	const content = (
		<span
			data-testid="document-status-badge"
			data-status={status}
			title={message ?? label}
			className={cn(
				"inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-ui text-[11px] font-medium transition-colors",
				style,
				className,
			)}
		>
			<Icon className="size-3 shrink-0" aria-hidden="true" />
			<span>{label}</span>
		</span>
	);

	if (deepLink) {
		return (
			<a
				href={deepLink}
				target="_blank"
				rel="noopener noreferrer"
				className="no-underline hover:opacity-80 transition-opacity"
			>
				{content}
			</a>
		);
	}

	return content;
}
