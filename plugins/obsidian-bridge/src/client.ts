/**
 * LearnHarness Bridge Client.
 * Exports BridgeTransport as BridgeClient and re-exports core transport, vault, settings, and modal types.
 */
export * from "./types.ts";
export * from "./transport.ts";
export { BridgeTransport as BridgeClient } from "./transport.ts";
export * from "./vault.ts";
export * from "./settings.ts";
export * from "./modals.ts";

