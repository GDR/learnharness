"use client";

import type { ReactNode } from "react";
import { DumbbellIcon, MessageSquareIcon, SearchIcon } from "lucide-react";

export type ComposerMode = "chat" | "ask";

/**
 * Toggle pill between Chat and Ask Sources mode.
 */
export function ComposerModeToggle({
	mode = "chat",
	onChange,
}: {
	mode?: ComposerMode;
	onChange?: (mode: ComposerMode) => void;
}) {
	return (
		<div
			data-testid="composer-mode-toggle"
			className="flex items-center rounded-full border border-border bg-card/60 p-0.5"
		>
			<button
				type="button"
				data-testid="composer-mode-chat"
				onClick={() => onChange?.("chat")}
				className={`flex cursor-pointer items-center gap-1 rounded-full px-2.5 py-1 font-ui text-xs transition-colors ${
					mode === "chat"
						? "bg-primary text-primary-foreground font-medium shadow-xs"
						: "text-muted-foreground hover:text-foreground"
				}`}
			>
				<MessageSquareIcon className="size-3" aria-hidden="true" />
				Chat
			</button>
			<button
				type="button"
				data-testid="composer-mode-ask"
				onClick={() => onChange?.("ask")}
				className={`flex cursor-pointer items-center gap-1 rounded-full px-2.5 py-1 font-ui text-xs transition-colors ${
					mode === "ask"
						? "bg-primary text-primary-foreground font-medium shadow-xs"
						: "text-muted-foreground hover:text-foreground"
				}`}
			>
				<SearchIcon className="size-3" aria-hidden="true" />
				Ask Sources
			</button>
		</div>
	);
}

/** Home and the draft share one wrapping action row. Picker controls lead;
 * setup is centered only when it is the sole action. */
export function ComposerActions({
	picker,
	setup,
	modeToggle,
	scope,
}: {
	picker?: ReactNode;
	setup?: ReactNode;
	modeToggle?: ReactNode;
	scope?: ReactNode;
}) {
	if (!picker && !setup && !modeToggle && !scope) return null;
	return (
		<div
			data-testid="composer-actions"
			className={`pointer-events-auto mb-2 flex flex-wrap items-center gap-2 ${
				picker || modeToggle || scope ? "justify-start" : "justify-center"
			}`}
		>
			{modeToggle}
			{scope}
			{picker}
			{setup}
		</div>
	);
}

/** Count and Clear stay together if the setup action wraps onto another line.
 * These are node counts, even when a whole chain supplied the selection. */
export function NodePickerControl({
	count,
	onOpen,
	onClear,
}: {
	count: number;
	onOpen?: () => void;
	onClear?: () => void;
}) {
	return (
		<div className="flex items-center gap-1.5">
			<button
				type="button"
				data-testid="practice-props-chip"
				onClick={onOpen}
				className={
					"flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 font-ui text-xs transition-colors " +
					(count > 0
						? "border-border bg-card text-foreground hover:bg-accent"
						: "border-dashed border-border/80 bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground")
				}
			>
				<DumbbellIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
				{count > 0 ? `${count} ${count === 1 ? "node" : "nodes"} selected` : "Pick nodes"}
			</button>
			{count > 0 && (
				<button
					type="button"
					data-testid="practice-props-clear"
					onClick={onClear}
					className="cursor-pointer rounded-full px-2 py-1 font-ui text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					Clear
				</button>
			)}
		</div>
	);
}
