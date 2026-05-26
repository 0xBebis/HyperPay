/**
 * Across Protocol Destination Verifier
 *
 * Verifies CCTP fill operations by querying the Across Protocol indexer
 * for Hyperliquid-to-EVM transfers. Matches on origin chain ID,
 * destination chain ID, and nonce.
 *
 * Zero dependencies — uses native `fetch` only.
 */

import type { DestinationVerifier } from "../interfaces";
import type { DepositOperation, FillOperation } from "../types";

/**
 * Configuration for {@link AcrossDestinationVerifier}.
 *
 * All fields are optional — sensible defaults are used when omitted.
 */
export interface AcrossDestinationVerifierConfig {
  /** Across indexer base URL (default: `"https://indexer.api.across.to"`). */
  indexerBaseUrl?: string;
}

/**
 * Shape of a single transfer record returned by the Across Protocol indexer.
 *
 * @internal Not exported — used only within the {@link AcrossDestinationVerifier}.
 */
interface AcrossTransfer {
  /** Transaction reference (hash) for the deposit on the source chain. */
  depositTxnRef: string | null;
  /** Transaction reference (hash) for the fill on the destination chain. */
  fillTxnRef: string | null;
  /** Chain ID where the deposit originated. */
  originChainId: number;
  /** Chain ID where the fill was executed. */
  destinationChainId: number;
  /** Deposit nonce as a string (compared against the source deposit nonce). */
  nonce: string;
  /** ISO-8601 timestamp of the block containing the fill on the destination chain. */
  destinationBlockTimestamp: string;
}

/**
 * Destination-side verifier using the Across Protocol indexer.
 *
 * Queries the Across indexer's `/hyperliquid-transfers` endpoint for
 * outbound transfers matching the origin chain, destination chain, and
 * deposit nonce. Uses only native `fetch` — no external dependencies.
 *
 * @example
 * ```typescript
 * const verifier = new AcrossDestinationVerifier();
 * const fill = await verifier.findFill({
 *   account: "0x...",
 *   deposit: { hash: "0xabc...", nonce: 42 },
 *   originChainId: 999,
 *   destinationChainId: 8453,
 * });
 * ```
 */
export class AcrossDestinationVerifier implements DestinationVerifier {
  private indexerBaseUrl: string;

  /**
   * Creates a new Across destination verifier.
   *
   * @param config - Optional configuration. Defaults to the public Across indexer URL.
   */
  constructor(config?: AcrossDestinationVerifierConfig) {
    this.indexerBaseUrl =
      config?.indexerBaseUrl || "https://indexer.api.across.to";
  }

  /**
   * Queries the Across indexer for a fill matching the given deposit.
   *
   * @param params - Search parameters (account, deposit, chain IDs).
   * @returns The matching {@link FillOperation}, or `null` if not found or on transient error.
   */
  async findFill(params: {
    account: string;
    deposit: DepositOperation;
    originChainId: number;
    destinationChainId: number;
  }): Promise<FillOperation | null> {
    try {
      const url = `${this.indexerBaseUrl}/hyperliquid-transfers?direction=out&user=${params.account}`;
      const response = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        console.warn(`[cctp-verify] Across API returned HTTP ${response.status}`);
        return null;
      }

      const transfers: AcrossTransfer[] = await response.json();

      const match = transfers.find(
        (t) =>
          t.originChainId === params.originChainId &&
          t.destinationChainId === params.destinationChainId &&
          t.nonce === params.deposit.nonce.toString(),
      );

      if (match?.fillTxnRef) {
        return { fillTxHash: match.fillTxnRef };
      }

      return null;
    } catch (err) {
      // Log but don't throw — the poller will retry on the next iteration.
      // Returning null means "fill not found yet", not "error occurred".
      if (typeof globalThis.console !== "undefined") {
        console.warn(
          `[cctp-verify] Across indexer fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return null;
    }
  }
}
