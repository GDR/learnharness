"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import type { IndexingJob, IndexingState } from "@/src/core";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface IndexingStatusIndicatorProps {
	projectId: string;
	sourceId?: string;
	initialJob?: IndexingJob | null;
	autoPoll?: boolean;
	onCompleted?: (job: IndexingJob) => void;
	className?: string;
	compact?: boolean;
}

export function IndexingStatusIndicator({
	projectId,
	sourceId,
	initialJob = null,
	autoPoll = true,
	onCompleted,
	className,
	compact = false,
}: IndexingStatusIndicatorProps) {
	const [job, setJob] = useState<IndexingJob | null>(initialJob);
	const [canceling, setCanceling] = useState(false);
	const lastNotifiedCompletedJobIdRef = useRef<string | null>(null);

	const pollStatus = useCallback(async () => {
		if (!projectId) return;
		try {
			const url = sourceId
				? `/api/projects/${projectId}/sources/${sourceId}/index`
				: `/api/projects/${projectId}/index/status`;
			const res = await fetch(url);
			if (!res.ok) return;

			const data = await res.json();
			const active: IndexingJob | null = sourceId
				? data.activeJob
				: (data.activeJobs?.[0] ?? data.queuedJobs?.[0] ?? null);
			const latest: IndexingJob | null = sourceId ? data.latestJob : data.recentJobs?.[0] ?? null;

			const currentJob = active || latest || null;
			setJob(currentJob);

			if (
				latest?.state === "completed" &&
				onCompleted &&
				lastNotifiedCompletedJobIdRef.current !== latest.id
			) {
				lastNotifiedCompletedJobIdRef.current = latest.id;
				onCompleted(latest);
			}
		} catch {
			// ignore polling network errors
		}
	}, [projectId, sourceId, onCompleted]);

	useEffect(() => {
		if (!autoPoll) return;
		const isActive =
			job &&
			(job.state === "queued" ||
				job.state === "scanning" ||
				job.state === "extracting" ||
				job.state === "validating" ||
				job.state === "committing");

		const intervalMs = isActive ? 1000 : 8000;
		const timer = setInterval(() => {
			void pollStatus();
		}, intervalMs);

		return () => clearInterval(timer);
	}, [autoPoll, job, pollStatus]);

	const handleCancel = async () => {
		if (!projectId || !sourceId || !job) return;
		setCanceling(true);
		try {
			const res = await fetch(`/api/projects/${projectId}/sources/${sourceId}/index`, {
				method: "DELETE",
			});
			if (res.ok) {
				const data = (await res.json()) as { job: IndexingJob };
				setJob(data.job);
			}
		} finally {
			setCanceling(false);
		}
	};

	if (!job) return null;

	const percent =
		job.progress.total > 0
			? Math.min(100, Math.round((job.progress.current / job.progress.total) * 100))
			: 0;

	const stageColorMap: Record<IndexingState, string> = {
		queued: "border-amber-500/20 bg-amber-500/10 text-amber-500",
		scanning: "border-sky-500/20 bg-sky-500/10 text-sky-500",
		extracting: "border-indigo-500/20 bg-indigo-500/10 text-indigo-500",
		validating: "border-purple-500/20 bg-purple-500/10 text-purple-500",
		committing: "border-cyan-500/20 bg-cyan-500/10 text-cyan-500",
		completed: "border-emerald-500/20 bg-emerald-500/10 text-emerald-500",
		failed: "border-rose-500/20 bg-rose-500/10 text-rose-500",
		canceled: "border-muted bg-muted/40 text-muted-foreground",
	};

	const isActive =
		job.state === "queued" ||
		job.state === "scanning" ||
		job.state === "extracting" ||
		job.state === "validating" ||
		job.state === "committing";

	if (compact) {
		return (
			<div
				data-testid={`indexing-status-compact-${job.id}`}
				className={cn(
					"inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-[10px] font-medium tracking-wide uppercase",
					stageColorMap[job.state],
					className,
				)}
			>
				{isActive && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
				<span>{job.state}</span>
				{job.state === "extracting" && <span>{percent}%</span>}
			</div>
		);
	}

	return (
		<div
			data-testid={`indexing-status-bar-${job.id}`}
			className={cn(
				"flex flex-col gap-1.5 rounded-md border border-border/60 bg-background/60 p-2.5 text-xs",
				className,
			)}
		>
			<div className="flex items-center justify-between gap-2">
				<div className="flex items-center gap-2">
					<span
						className={cn(
							"rounded px-1.5 py-0.5 text-[10px] uppercase font-semibold tracking-wider",
							stageColorMap[job.state],
						)}
					>
						{job.state}
					</span>
					{job.progress.currentDocument && (
						<span
							data-testid="indexing-current-document"
							className="max-w-[200px] truncate font-mono text-[11px] text-muted-foreground"
							title={job.progress.currentDocument}
						>
							{job.progress.currentDocument}
						</span>
					)}
				</div>

				<div className="flex items-center gap-2">
					{isActive && sourceId && (
						<Button
							variant="ghost"
							size="sm"
							data-testid="btn-cancel-indexing"
							onClick={() => void handleCancel()}
							disabled={canceling}
							className="h-5 px-1.5 text-[10px] text-rose-500 hover:bg-rose-500/10 hover:text-rose-600"
						>
							{canceling ? "Canceling…" : "Cancel"}
						</Button>
					)}
					{job.stats.elapsedMs > 0 && (
						<span className="font-mono text-[10px] text-muted-foreground">
							{(job.stats.elapsedMs / 1000).toFixed(1)}s
						</span>
					)}
				</div>
			</div>

			{job.state === "queued" && (
				<p data-testid="indexing-queued-message" className="text-[11px] text-muted-foreground">
					Queued in background...
				</p>
			)}

			{isActive && job.progress.total > 0 && (
				<div className="flex items-center gap-2">
					<div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
						<div
							data-testid="indexing-progress-bar"
							className="h-full bg-primary transition-all duration-300"
							style={{ width: `${percent}%` }}
						/>
					</div>
					<span className="font-mono text-[10px] text-muted-foreground">
						{job.progress.current}/{job.progress.total} ({percent}%)
					</span>
				</div>
			)}

			<div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[10px] text-muted-foreground">
				<span>+{job.stats.added} added</span>
				<span>~{job.stats.modified} modified</span>
				<span>={job.stats.unchanged} unchanged</span>
				<span>-{job.stats.removed} removed</span>
				<span>{job.stats.extractedPropositions} props</span>
			</div>

			{job.error && (
				<p data-testid="indexing-error-message" className="mt-1 text-[11px] text-rose-500">
					{job.error}
				</p>
			)}
		</div>
	);
}
