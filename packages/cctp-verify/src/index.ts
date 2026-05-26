/**
 * @cod3x/cctp-verify — Cross-Chain Transfer Protocol settlement verification.
 *
 * Provides a pluggable, dual-poll verification pattern for confirming that a
 * CCTP transfer has been initiated on a source chain and settled (filled) on a
 * destination chain.
 *
 * Built-in verifiers:
 * - {@link HyperliquidSourceVerifier} — source-side verification via the Hyperliquid ledger
 * - {@link AcrossDestinationVerifier} — destination-side verification via the Across Protocol indexer
 *
 * @packageDocumentation
 */

export * from "./types";
export * from "./interfaces";
export { dualPollVerify } from "./poller";
export { HyperliquidSourceVerifier } from "./verifiers/hyperliquid";
export { AcrossDestinationVerifier } from "./verifiers/across";
