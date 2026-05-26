/**
 * Step: CCTP Bridge
 *
 * Bridge USDC from a source chain to the target chain via Circle CCTP.
 * Three-phase flow: burn -> attestation -> mint.
 *
 * Idempotent on retry:
 * - If `mint_tx_hash` is set, bridge is complete -- skip
 * - If `burn_tx_hash` is set but mint isn't, resume from attestation polling
 * - Otherwise, initiate a fresh burn
 *
 * For Hypercore (domain -1), the burn step uses Hyperliquid's
 * `sendToEvmWithData()` and settlement is verified via the Across indexer.
 *
 * @packageDocumentation
 */

import type { FundingConfig, FundingJobData, CctpChain } from "../types";
import type {
  CctpBridgeProvider,
  CancellationChecker,
  FundingEventEmitter,
  StateStore,
  FundingLogger,
} from "../interfaces";
import { JobCancelledError } from "../utils/error";

/**
 * Execute a Circle CCTP bridge from a source chain to the target chain.
 *
 * Performs the three-phase CCTP flow:
 * 1. **Burn** -- call `TokenMessenger.depositForBurn()` on the source chain
 *    (or `sendToEvmWithData()` for Hypercore)
 * 2. **Attest** -- poll Circle's Iris API until the attestation is ready
 * 3. **Mint** -- call `MessageTransmitter.receiveMessage()` on the target chain
 *
 * Each phase persists its result to the state store, so retries skip
 * already-completed phases.
 *
 * @param params - Step parameters including job data, config, and provider dependencies.
 * @param params.jobData - The funding job being processed.
 * @param params.config - Pipeline configuration (chain definitions, timeouts).
 * @param params.sourceChainId - Chain ID where the USDC currently resides.
 * @param params.usdcAmount - USDC amount to bridge in atomic units (6 decimals).
 * @param params.cctp - CCTP bridge provider for burn/attest/mint operations.
 * @param params.cancellation - Provider for checking job cancellation.
 * @param params.events - Event emitter for progress updates.
 * @param params.state - State store for persisting intermediate results.
 * @param params.logger - Logger instance.
 * @param params.existing - Previously persisted state for idempotent resume (optional).
 * @throws {JobCancelledError} If the job is cancelled during attestation polling.
 * @throws {Error} If the source or target chain is not in supported chains,
 *                 or if the attestation timeout is exceeded.
 */
export async function stepCctpBridge(params: {
  jobData: FundingJobData;
  config: FundingConfig;
  sourceChainId: string;
  usdcAmount: bigint;
  cctp: CctpBridgeProvider;
  cancellation: CancellationChecker;
  events: FundingEventEmitter;
  state: StateStore;
  logger: FundingLogger;
  existing?: any;
}): Promise<void> {
  const { jobData, config, sourceChainId, usdcAmount, cctp, cancellation, events, state, logger, existing } = params;

  const sourceChain = config.supportedChains.find((c) => c.id === sourceChainId);
  if (!sourceChain) throw new Error(`Source chain ${sourceChainId} not in supported chains`);

  const targetChain = config.supportedChains.find((c) => c.id === config.targetChainId);
  if (!targetChain) throw new Error(`Target chain ${config.targetChainId} not in supported chains`);

  // Already complete — mint tx confirmed on a prior run
  if (existing?.mint_tx_hash) {
    logger.info(`[funding] CCTP bridge already complete — skipping`);
    return;
  }

  // ── Phase 1: Burn ────────────────────────────────────────────────────

  let burnTxHash = existing?.burn_tx_hash as string | undefined;

  if (!burnTxHash) {
    events.emit({
      jobId: jobData.jobId,
      state: "bridging",
      progress: 18,
      message: `Burning ${Number(usdcAmount) / 1e6} USDC on ${sourceChain.label}...`,
    });

    const burnResult = await cctp.burn({
      wallet: jobData.agentWallet,
      sourceChainId,
      destinationDomain: targetChain.cctpDomain,
      amount: usdcAmount,
      destinationRecipient: jobData.agentWallet,
    });

    burnTxHash = burnResult.txHash;
    await state.updateJob(jobData.jobId, {
      burn_tx_hash: burnTxHash,
      burn_nonce: burnResult.nonce,
      source_chain_id: sourceChainId,
    });

    events.emit({
      jobId: jobData.jobId,
      state: "bridging",
      progress: 22,
      message: `Burn confirmed on ${sourceChain.label} — waiting for Circle attestation...`,
      txHashes: { burn: burnTxHash },
    });
  } else {
    logger.info(`[funding] Resuming from prior burn tx ${burnTxHash}`);
  }

  // ── Phase 2: Attestation ─────────────────────────────────────────────

  events.emit({
    jobId: jobData.jobId,
    state: "bridging",
    progress: 25,
    message: "Waiting for Circle attestation...",
  });

  let attestation: string | undefined;
  let message: string | undefined;

  // Check if attestation was already fetched on a prior run
  if (existing?.cctp_attestation && existing?.cctp_message) {
    attestation = existing.cctp_attestation;
    message = existing.cctp_message;
    logger.info(`[funding] Using cached attestation`);
  } else {
    const attStart = Date.now();
    while (Date.now() - attStart < config.bridgeTimeoutMs) {
      if (await cancellation.isCancelled(jobData.jobId)) {
        throw new JobCancelledError(jobData.jobId);
      }

      const result = await cctp.getAttestation({
        burnTxHash: burnTxHash!,
        sourceChainId,
      }).catch((err) => {
        logger.warn(`[funding] Attestation fetch failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      });

      if (result?.status === "complete" && result.attestation && result.message) {
        attestation = result.attestation;
        message = result.message;

        // Persist attestation for idempotency
        await state.updateJob(jobData.jobId, {
          cctp_attestation: attestation,
          cctp_message: message,
          cctp_message_hash: result.messageHash,
        });

        events.emit({
          jobId: jobData.jobId,
          state: "bridging",
          progress: 30,
          message: "Attestation received — minting on destination chain...",
          txHashes: { attestation: result.messageHash },
        });
        break;
      }

      await new Promise((r) => setTimeout(r, config.attestationPollIntervalMs));
    }

    if (!attestation || !message) {
      throw new Error(
        `CCTP attestation timeout after ${config.bridgeTimeoutMs / 60000} minutes for burn tx ${burnTxHash}`,
      );
    }
  }

  // ── Phase 3: Mint ────────────────────────────────────────────────────

  const mintResult = await cctp.mint({
    attestation,
    message,
    destinationChainId: config.targetChainId,
    wallet: jobData.agentWallet,
  });

  await state.updateJob(jobData.jobId, { mint_tx_hash: mintResult.txHash });

  events.emit({
    jobId: jobData.jobId,
    state: "bridging",
    progress: 35,
    message: `USDC minted on ${targetChain.label}`,
    txHashes: { mint: mintResult.txHash },
  });

  logger.info(`[funding] CCTP bridge complete: burn=${burnTxHash} → mint=${mintResult.txHash}`);
}
