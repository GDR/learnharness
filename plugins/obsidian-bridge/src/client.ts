/**
 * LearnHarness Bridge Client.
 * Exports BridgeTransport as BridgeClient and re-exports core transport types.
 */
export * from "./transport.ts";
export { BridgeTransport as BridgeClient } from "./transport.ts";
