/**
 * Shared contracts — the single source of truth every component codes against.
 *
 * Split by domain (src/core/contracts/): plan.ts (the session plan tree),
 * graph.ts (the global knowledge graph + its extraction pipeline), chat.ts
 * (session records + UI extension points), jobs.ts (the async sub-agent
 * protocol),  Each domain file is
 * owned outright by its stream; schema changes to a domain you don't own go
 * through master. This barrel keeps every existing import path
 * ("@/src/core" and "./contracts.ts") unchanged.
 */

export * from "./contracts/plan.ts";
export * from "./contracts/graph.ts";
export * from "./contracts/chat.ts";
export * from "./contracts/jobs.ts";
export * from "./contracts/probe.ts";
export * from "./contracts/models.ts";
export * from "./contracts/project.ts";
export * from "./contracts/obsidian.ts";
export * from "./contracts/chunker.ts";
export * from "./contracts/indexing.ts";
export * from "./contracts/evidence.ts";
export * from "./contracts/reconciler.ts";
export * from "./contracts/scope.ts";
export * from "./contracts/session.ts";

