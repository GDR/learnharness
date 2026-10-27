/**
 * PracticeStore — file-backed implementation of the PracticeStore port.
 *
 * Stores problem sets in data/projects/<id>/practice/ as JSON files.
 * Uses crash-safe POSIX atomic writes (writeAtomicJsonSync).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import crypto from "node:crypto";
import type { PracticeStore, ProblemSet } from "../core/ports.ts";
import type { ProjectId } from "../core/contracts/project.ts";
import { writeAtomicJsonSync } from "../core/fs-atomic.ts";

export function createPracticeStore(practiceDir: string): PracticeStore {
	const resolvedPracticeDir = path.resolve(practiceDir);

	function problemSetFile(id: string): string {
		if (!/^[A-Za-z0-9_-]+$/.test(id)) {
			throw new Error(`Invalid problem set id: ${id}`);
		}
		return path.join(resolvedPracticeDir, `${id}.json`);
	}

	async function createProblemSet(init: {
		projectId: ProjectId;
		title: string;
		nodeIds: string[];
		propositions: Record<string, { name: string; statement: string }>;
		chains: import("../core/contracts.ts").GraphChain[];
		scope?: import("../core/contracts/scope.ts").StudyScope;
	}): Promise<ProblemSet> {
		fs.mkdirSync(resolvedPracticeDir, { recursive: true });
		const now = new Date().toISOString();
		const id = `pset_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
		const problemSet: ProblemSet = {
			id,
			projectId: init.projectId,
			title: init.title.trim() || "Untitled problem set",
			createdAt: now,
			updatedAt: now,
			nodeIds: [...init.nodeIds],
			propositions: { ...init.propositions },
			chains: [...init.chains],
			status: "active",
			...(init.scope ? { scope: init.scope } : {}),
		};

		writeAtomicJsonSync(problemSetFile(id), problemSet);
		return problemSet;
	}


	async function getProblemSet(id: string): Promise<ProblemSet | null> {
		try {
			const file = problemSetFile(id);
			if (!fs.existsSync(file)) return null;
			const raw = fs.readFileSync(file, "utf-8");
			return JSON.parse(raw) as ProblemSet;
		} catch {
			return null;
		}
	}

	async function listProblemSets(projectId?: ProjectId): Promise<ProblemSet[]> {
		try {
			if (!fs.existsSync(resolvedPracticeDir)) return [];
			const files = fs.readdirSync(resolvedPracticeDir).filter((f) => f.endsWith(".json"));
			const results: ProblemSet[] = [];
			for (const file of files) {
				const id = file.slice(0, -5);
				const pset = await getProblemSet(id);
				if (pset && (!projectId || pset.projectId === projectId)) {
					results.push(pset);
				}
			}
			return results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		} catch {
			return [];
		}
	}

	async function updateProblemSet(id: string, patch: Partial<ProblemSet>): Promise<ProblemSet | null> {
		const existing = await getProblemSet(id);
		if (!existing) return null;

		const updated: ProblemSet = {
			...existing,
			...patch,
			id: existing.id,
			projectId: existing.projectId,
			createdAt: existing.createdAt,
			updatedAt: patch.updatedAt ?? new Date().toISOString(),
		};

		writeAtomicJsonSync(problemSetFile(id), updated);
		return updated;
	}

	async function deleteProblemSet(id: string): Promise<boolean> {
		try {
			const file = problemSetFile(id);
			if (!fs.existsSync(file)) return false;
			fs.unlinkSync(file);
			return true;
		} catch {
			return false;
		}
	}

	return {
		createProblemSet,
		getProblemSet,
		listProblemSets,
		updateProblemSet,
		deleteProblemSet,
	};
}
