/**
 * CCTP Verification — Dual-Poll Verification
 *
 * The core abstraction: polls the source chain for a deposit confirmation,
 * then polls the destination chain for a fill confirmation. Returns when
 * both are found, or throws on timeout.
 *
 * This pattern works for any cross-chain transfer protocol that has:
 * 1. A source-side operation (burn/lock/send) with a unique identifier
 * 2. A destination-side operation (mint/unlock/fill) that can be matched
 */

import type { SourceVerifier, DestinationVerifier } from "./interfaces";
import type { CctpTransferResult, VerificationConfig } from "./types";

/**
 * Dual-poll a CCTP transfer until both source deposit and destination fill
 * are confirmed, or timeout is reached.
 *
 * Transient errors from verifiers are caught and retried on the next poll
 * iteration. Only permanent errors (thrown outside the verifiers) abort
 * the verification.
 *
 * @throws Error on timeout (includes diagnostic context)
 *
 * @example
 * ```typescript
 * try {
 *   const result = await dualPollVerify(
 *     new HyperliquidSourceVerifier({ getCCTPTransfers }),
 *     new AcrossDestinationVerifier(),
 *     {
 *       account: "0x...",
 *       initiatedAfter: Date.now(),
 *       expectedAmount: 25,
 *       expectedToken: "USDC",
 *       originChainId: 999,
 *       destinationChainId: 8453,
 *     },
 *   );
 *   console.log(`Settled: ${result.fillTxHash}`);
 * } catch (err) {
 *   console.error(`Verification failed: ${err.message}`);
 * }
 * ```
 */
export async function dualPollVerify(
  source: SourceVerifier,
  destination: DestinationVerifier,
  params: {
    account: string;
    initiatedAfter: number;
    expectedAmount: number;
    expectedToken: string;
    originChainId: number;
    destinationChainId: number;
  },
  config?: VerificationConfig,
): Promise<CctpTransferResult> {
  // Input validation
  if (!params.account) {
    throw new Error("account must be a non-empty string");
  }
  if (params.expectedAmount <= 0) {
    throw new Error("expectedAmount must be greater than 0");
  }
  if (!params.expectedToken) {
    throw new Error("expectedToken must be a non-empty string");
  }

  const pollingIntervalMs = config?.pollingIntervalMs ?? 2000;
  const maxAttempts = config?.maxAttempts ?? 150;
  const onProgress = config?.onProgress;

  let depositHash: string | null = null;
  let depositNonce = 0;
  let depositFound = false;
  let fillTxHash: string | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Phase 1: Find the deposit on the source chain
    if (!depositFound) {
      try {
        const deposit = await source.findDeposit({
          account: params.account,
          initiatedAfter: params.initiatedAfter,
          expectedAmount: params.expectedAmount,
          expectedToken: params.expectedToken,
        });

        if (deposit) {
          depositHash = deposit.hash;
          depositNonce = deposit.nonce;
          depositFound = true;
        }
      } catch (err) {
        // Transient source error — log and retry on next iteration
        if (typeof globalThis.console !== "undefined") {
          console.warn(
            `[cctp-verify] Source verifier error (attempt ${attempt + 1}): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    // Phase 2: Find the fill on the destination chain (use boolean flag, not nonce — nonce could be 0)
    if (depositFound && !fillTxHash) {
      try {
        const fill = await destination.findFill({
          account: params.account,
          deposit: { hash: depositHash, nonce: depositNonce },
          originChainId: params.originChainId,
          destinationChainId: params.destinationChainId,
        });

        if (fill?.fillTxHash) {
          fillTxHash = fill.fillTxHash;
        }
      } catch (err) {
        // Transient destination error — log and retry on next iteration
        if (typeof globalThis.console !== "undefined") {
          console.warn(
            `[cctp-verify] Destination verifier error (attempt ${attempt + 1}): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    // Both found — settlement confirmed
    if (fillTxHash) {
      return {
        depositTxHash: depositHash,
        fillTxHash,
        nonce: depositNonce,
        settled: true,
      };
    }

    onProgress?.(attempt, {
      depositFound,
      fillFound: !!fillTxHash,
    });

    await new Promise((resolve) => setTimeout(resolve, pollingIntervalMs));
  }

  // Timeout — include diagnostic context
  const timeoutSec = (maxAttempts * pollingIntervalMs) / 1000;
  throw new Error(
    `CCTP settlement verification timed out after ${timeoutSec}s (${maxAttempts} attempts). ` +
      `Deposit ${depositFound ? `found on chain ${params.originChainId} (nonce=${depositNonce})` : "NOT found on source chain"}. ` +
      `Fill NOT found on destination chain ${params.destinationChainId}. ` +
      `Expected: ${params.expectedAmount} ${params.expectedToken} from ${params.account}.`,
  );
}
