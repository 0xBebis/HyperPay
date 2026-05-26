/**
 * CCTP Verification — Pluggable Verifier Interfaces
 *
 * Implement these interfaces to support any source/destination chain
 * combination for CCTP settlement verification.
 */

import type { DepositOperation, FillOperation } from "./types";

/**
 * Verifies that a CCTP transfer was initiated on the source chain.
 *
 * Implementations query the source chain's ledger/logs to find a
 * withdrawal/burn matching the expected parameters.
 *
 * Built-in: `HyperliquidSourceVerifier` — queries HL's non-funding ledger.
 */
export interface SourceVerifier {
  findDeposit(params: {
    /** The sender's address on the source chain. */
    account: string;
    /** Timestamp (ms) after which the transfer was initiated. */
    initiatedAfter: number;
    /** Expected transfer amount (human-readable, e.g. 25 for $25 USDC). */
    expectedAmount: number;
    /** Expected token symbol (e.g. "USDC"). */
    expectedToken: string;
  }): Promise<DepositOperation | null>;
}

/**
 * Verifies that a CCTP transfer was completed on the destination chain.
 *
 * Implementations query the destination chain or a bridge indexer to find
 * a fill/mint matching the source deposit's nonce and chain IDs.
 *
 * Built-in: `AcrossDestinationVerifier` — queries the Across Protocol indexer.
 */
export interface DestinationVerifier {
  findFill(params: {
    /** The sender's address (same across chains for CCTP). */
    account: string;
    /** The deposit operation found on the source chain. */
    deposit: DepositOperation;
    /** Source chain ID (e.g., 999 for HyperEVM). */
    originChainId: number;
    /** Destination chain ID (e.g., 8453 for Base). */
    destinationChainId: number;
  }): Promise<FillOperation | null>;
}
