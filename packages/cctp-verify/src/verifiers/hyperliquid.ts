/**
 * Hyperliquid Source Verifier
 *
 * Verifies CCTP deposits by querying Hyperliquid's non-funding ledger
 * for sends to the CCTP bridge address (0x2000...0000).
 *
 * The `getCCTPTransfers` function is injected — this package does NOT
 * depend on @nktkas/hyperliquid or any HL SDK. Callers provide their
 * own HLExchange instance to fetch the transfers.
 */

import type { SourceVerifier } from "../interfaces";
import type { DepositOperation } from "../types";

/** Shape of a single CCTP transfer entry from the Hyperliquid ledger. */
export interface HyperliquidCCTPTransfer {
  /** The transfer delta containing token, amount, and nonce information. */
  delta: {
    /** Token symbol (e.g. "USDC"). */
    token: string;
    /** Transfer amount (may be a number or string depending on the HL SDK). */
    amount: number | string;
    /** Source-side nonce used to match with the destination fill. */
    nonce: number;
  };
  /** Transaction hash on HyperEVM, or null if not yet indexed. */
  hash: string | null;
}

/**
 * Configuration for {@link HyperliquidSourceVerifier}.
 *
 * Requires a single function that fetches CCTP transfers from the HL ledger.
 * This design avoids a hard dependency on any Hyperliquid SDK — callers inject
 * their own implementation.
 */
export interface HyperliquidSourceVerifierConfig {
  /**
   * Function that fetches CCTP transfers from the HL ledger.
   * Typically: `(account, startTime) => hlExchange.getCCTPTransfers(account, startTime)`
   *
   * @param account - The sender's Ethereum address.
   * @param startTime - Unix timestamp (ms) to start searching from.
   * @returns Array of CCTP transfer entries from the ledger.
   */
  getCCTPTransfers: (
    account: string,
    startTime: number,
  ) => Promise<HyperliquidCCTPTransfer[]>;
}

/**
 * Source-side verifier for Hyperliquid CCTP deposits.
 *
 * Queries the Hyperliquid non-funding ledger for a CCTP send matching
 * the expected token, amount, and time window. The underlying fetch
 * function is injected at construction time so that this package
 * carries no dependency on any Hyperliquid SDK.
 *
 * @example
 * ```typescript
 * const verifier = new HyperliquidSourceVerifier({
 *   getCCTPTransfers: (account, startTime) =>
 *     hlExchange.getCCTPTransfers(account, startTime),
 * });
 * const deposit = await verifier.findDeposit({
 *   account: "0x...",
 *   initiatedAfter: Date.now(),
 *   expectedAmount: 25,
 *   expectedToken: "USDC",
 * });
 * ```
 */
export class HyperliquidSourceVerifier implements SourceVerifier {
  private getCCTPTransfers: HyperliquidSourceVerifierConfig["getCCTPTransfers"];

  /**
   * Creates a new Hyperliquid source verifier.
   *
   * @param config - Configuration containing the `getCCTPTransfers` fetch function.
   */
  constructor(config: HyperliquidSourceVerifierConfig) {
    this.getCCTPTransfers = config.getCCTPTransfers;
  }

  /**
   * Searches the Hyperliquid ledger for a CCTP deposit matching the given parameters.
   *
   * @param params - Search parameters (account, time window, expected amount/token).
   * @returns The matching {@link DepositOperation}, or `null` if not found or on transient error.
   */
  async findDeposit(params: {
    account: string;
    initiatedAfter: number;
    expectedAmount: number;
    expectedToken: string;
  }): Promise<DepositOperation | null> {
    try {
      const transfers = await this.getCCTPTransfers(
        params.account,
        params.initiatedAfter,
      );

      const match = transfers.find(
        (t) =>
          t.delta.token === params.expectedToken &&
          +t.delta.amount === params.expectedAmount,
      );

      if (match) {
        if (match.delta.nonce === undefined || match.delta.nonce === null) {
          throw new Error("CCTP transfer found but nonce is missing from ledger entry");
        }
        return {
          hash: match.hash ?? null,
          nonce: match.delta.nonce,
        };
      }

      return null;
    } catch (err) {
      // Transient errors are caught here so the poller can retry.
      if (typeof globalThis.console !== "undefined") {
        console.warn(
          `[cctp-verify] Hyperliquid transfer lookup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return null;
    }
  }
}
