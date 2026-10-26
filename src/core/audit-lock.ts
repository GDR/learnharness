/**
 * Core Project Validation & Project-Keyed Audit Locks.
 *
 * Enforces architectural boundary layering: pure core validation and
 * in-process serialization locks accessible by both agent and server layers
 * without violating eslint restricted zone imports.
 */

import {
	type ProjectId,
	projectIdSchema,
} from "./contracts/project.ts";

export class InvalidProjectIdError extends Error {
	readonly status = 400;
	constructor(message = "Invalid projectId") {
		super(message);
		this.name = "InvalidProjectIdError";
	}
}

/**
 * Validates project ID format. Throws InvalidProjectIdError (status 400)
 * on empty, missing, non-string, or regex-invalid project ID.
 */
export function validateProjectId(raw: unknown): ProjectId {
	if (typeof raw !== "string" || !raw.trim()) {
		throw new InvalidProjectIdError("projectId must be a non-empty string");
	}
	const result = projectIdSchema.safeParse(raw.trim());
	if (!result.success) {
		throw new InvalidProjectIdError(
			result.error.issues[0]?.message ?? `Invalid projectId format: "${String(raw)}"`,
		);
	}
	return result.data;
}

interface GlobalProjectAuditLocks {
	__lhProjectAuditLocks?: Map<ProjectId, { tail: Promise<void> }>;
}

/**
 * Project-keyed writer locks replacing globalThis.__lhAuditLock.
 * Serializes audit and ledger commits per-project while allowing
 * concurrent operations across distinct projects to run in parallel.
 */
export function getProjectAuditLock(projectId: unknown): <T>(fn: () => Promise<T>) => Promise<T> {
	const validId = validateProjectId(projectId);
	const g = globalThis as typeof globalThis & GlobalProjectAuditLocks;
	const locks = (g.__lhProjectAuditLocks ??= new Map());

	let lock = locks.get(validId);
	if (!lock) {
		lock = { tail: Promise.resolve() };
		locks.set(validId, lock);
	}

	return async function withLock<T>(fn: () => Promise<T>): Promise<T> {
		const prev = lock.tail;
		let release!: () => void;
		lock.tail = new Promise<void>((resolve) => (release = resolve));
		try {
			await prev;
			return await fn();
		} finally {
			release();
		}
	};
}

/**
 * Clears in-process project audit locks (intended for test tear-down).
 */
export function clearProjectAuditLocks(): void {
	const g = globalThis as typeof globalThis & GlobalProjectAuditLocks;
	g.__lhProjectAuditLocks?.clear();
}
