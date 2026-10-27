"use client";

import React, { useState } from "react";
import type { SourceCitation, StudyScope } from "@/src/core";
import { Composer } from "../composer.tsx";
import { ComposerActions, ComposerModeToggle, type ComposerMode } from "../composer-actions.tsx";
import { StudyScopeIndicator } from "../composer/study-scope.tsx";
import { CitationBadge } from "../composer/citation-badge.tsx";

export interface ChatComposerProps {
	busy: boolean;
	value: string;
	onChange: (v: string) => void;
	onSend: () => void;
	onStop: () => void;
	canSend: boolean;
	mode?: ComposerMode;
	onModeChange?: (mode: ComposerMode) => void;
	scope?: StudyScope;
	onScopeClick?: () => void;
	citations?: SourceCitation[];
	placeholder?: string;
	autoFocus?: boolean;
}

/**
 * Integrated Chat Composer supporting standard Chat turns and Ask Sources mode,
 * including active StudyScope indicator and inline citations with Obsidian deep-links.
 */
export function ChatComposer({
	busy,
	value,
	onChange,
	onSend,
	onStop,
	canSend,
	mode = "chat",
	onModeChange,
	scope,
	onScopeClick,
	citations,
	placeholder,
	autoFocus,
}: ChatComposerProps) {
	const [activeMode, setActiveMode] = useState<ComposerMode>(mode);

	const handleModeChange = (newMode: ComposerMode) => {
		setActiveMode(newMode);
		onModeChange?.(newMode);
	};

	return (
		<div data-testid="chat-composer" className="flex flex-col gap-1.5">
			<ComposerActions
				modeToggle={
					<ComposerModeToggle mode={activeMode} onChange={handleModeChange} />
				}
				scope={
					activeMode === "ask" ? (
						<StudyScopeIndicator scope={scope} onClick={onScopeClick} />
					) : undefined
				}
			/>

			<div className="relative rounded-2xl border border-border bg-card/90 shadow-xs">
				<Composer
					busy={busy}
					value={value}
					onChange={onChange}
					onSend={onSend}
					onStop={onStop}
					canSend={canSend}
					mode={activeMode}
					onModeChange={handleModeChange}
					placeholder={placeholder}
					autoFocus={autoFocus}
				/>
			</div>

			{citations && citations.length > 0 && (
				<div
					data-testid="chat-composer-citations"
					className="flex flex-wrap items-center gap-1.5 px-1 py-1"
				>
					{citations.map((c, idx) => (
						<CitationBadge key={`${c.sourceId}-${c.documentPath}-${idx}`} citation={c} index={idx + 1} />
					))}
				</div>
			)}
		</div>
	);
}
