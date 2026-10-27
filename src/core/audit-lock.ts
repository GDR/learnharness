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

interface AsyncLocalStorageLike<T> {
	getStore(): T | undefined;
	run<R>(store: T, callback: () => R): R;
}

type AsyncLocalStorageConstructor = new <T>() => AsyncLocalStorageLike<T>;

function resolveAsyncLocalStorage(): AsyncLocalStorageConstructor | undefined {
	try {
		const proc = (globalThis as unknown as {
			process?: {
				getBuiltinModule?: (id: string) => { AsyncLocalStorage?: AsyncLocalStorageConstructor };
			};
		}).process;
		if (typeof proc?.getBuiltinModule === "function") {
			return proc.getBuiltinModule("node:async_hooks")?.AsyncLocalStorage;
		}
	} catch {
		// Browser or non-node runtime
	}
	return undefined;
}

const NodeAsyncLocalStorage = resolveAsyncLocalStorage();

interface GlobalProjectAuditLocks {
	__lhProjectAuditLocks?: Map<ProjectId, { tail: Promise<void> }>;
	__lhProjectHeldLocks?: AsyncLocalStorageLike<Set<ProjectId>>;
}

/**
 * Project-keyed writer locks replacing globalThis.__lhAuditLock.
 * Serializes audit and ledger commits per-project while allowing
 * concurrent operations across distinct projects to run in parallel.
 * Supports re-entrant acquisition within the same async context when run under Node.js.
 */
export function getProjectAuditLock(projectId: unknown): <T>(fn: () => Promise<T>) => Promise<T> {
	const validId = validateProjectId(projectId);
	const g = globalThis as typeof globalThis & GlobalProjectAuditLocks;
	const locks = (g.__lhProjectAuditLocks ??= new Map());
	const heldStorage = (g.__lhProjectHeldLocks ??= NodeAsyncLocalStorage ? new NodeAsyncLocalStorage<Set<ProjectId>>() : undefined);

	let lock = locks.get(validId);
	if (!lock) {
		lock = { tail: Promise.resolve() };
		locks.set(validId, lock);
	}

	return async function withLock<T>(fn: () => Promise<T>): Promise<T> {
		const currentHeld = heldStorage?.getStore();
		if (currentHeld?.has(validId)) {
			// Re-entrant lock for this project within the same async execution context
			return fn();
		}

		const prev = lock.tail;
		let release!: () => void;
		lock.tail = new Promise<void>((resolve) => (release = resolve));
		try {
			await prev;
			if (heldStorage) {
				const nextHeld = new Set(currentHeld);
				nextHeld.add(validId);
				return await heldStorage.run(nextHeld, fn);
			}
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
