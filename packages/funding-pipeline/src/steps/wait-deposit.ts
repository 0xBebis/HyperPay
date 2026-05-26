/**
 * Step: Wait for USDC Deposit
 *
 * Polls the agent wallet's USDC balance across all supported CCTP chains
 * until a deposit meets the funding threshold (95% of committed amount).
 * Favors the target chain (no bridge needed) over other chains.
 *
 * @packageDocumentation
 */

import type { FundingConfig, FundingJobData, DepositDetection } from "../types";
import type {
  UsdcBalanceProvider,
  CancellationChecker,
  FundingEventEmitter,
  StateStore,
  FundingLogger,
} from "../interfaces";
import { JobCancelledError } from "../utils/error";

/**
 * Wait for a USDC deposit to arrive on any supported CCTP chain.
 *
 * The function polls all supported chains in parallel at the configured interval
 * and returns as soon as a deposit delta meets the funding threshold
 * (`amountUsdc * fundingTargetFraction`). The target chain is preferred to avoid
 * an unnecessary CCTP bridge step.
 *
 * **Idempotency**: If `existing.deposit_usdc_amount` is already set in the
 * persisted state, the function returns immediately without polling.
 *
 * @param params - Step parameters including job data, config, and provider dependencies.
 * @param params.jobData - The funding job being processed.
 * @param params.config - Pipeline configuration (supported chains, timeouts, polling intervals).
 * @param params.balance - Provider for reading USDC balances.
 * @param params.cancellation - Provider for checking job cancellation.
 * @param params.events - Event emitter for progress updates.
 * @param params.state - State store for persisting deposit detection results.
 * @param params.logger - Logger instance.
 * @param params.existing - Previously persisted state for idempotent resume (optional).
 * @returns The detected deposit (chain ID and atomic USDC amount).
 * @throws {JobCancelledError} If the job is cancelled during polling.
 * @throws {Error} If the deposit timeout is exceeded without meeting the threshold.
 */
export async function stepWaitForDeposit(params: {
  jobData: FundingJobData;
  config: FundingConfig;
  balance: UsdcBalanceProvider;
  cancellation: CancellationChecker;
  events: FundingEventEmitter;
  state: StateStore;
  logger: FundingLogger;
  existing?: any;
}): Promise<DepositDetection> {
  const { jobData, config, balance, cancellation, events, state, logger, existing } = params;

  // Idempotency: if a previous run already detected the deposit, reuse it
  if (existing?.deposit_usdc_amount && Number(existing.deposit_usdc_amount) > 0) {
    const chainId = existing.source_chain_id ?? config.targetChainId;
    const amount = BigInt(existing.deposit_usdc_amount);
    logger.info(`[funding] Skipping deposit wait — already detected ${existing.deposit_usdc_amount} USDC on chain ${chainId}`);
    return { chainId, usdcAmount: amount };
  }

  const targetUsdc = jobData.amountUsdc * config.fundingTargetFraction;

  // Check if wallet already has enough USDC on target chain
  const existingOnTarget = await balance.getUsdcBalance(
    jobData.agentWallet,
    config.targetChainId,
  );
  const existingUsdc = Number(existingOnTarget) / 1e6;
  if (existingUsdc >= targetUsdc) {
    logger.info(`[funding] Wallet has ${existingUsdc.toFixed(2)} USDC on target chain — skipping deposit wait`);
    await state.updateJob(jobData.jobId, { deposit_usdc_amount: existingOnTarget.toString(), source_chain_id: config.targetChainId });
    events.emit({ jobId: jobData.jobId, state: "waiting_deposit", progress: 15, message: `Found $${existingUsdc.toFixed(2)} USDC` });
    return { chainId: config.targetChainId, usdcAmount: existingOnTarget };
  }

  events.emit({
    jobId: jobData.jobId,
    state: "waiting_deposit",
    progress: 5,
    message: `Waiting for $${jobData.amountUsdc.toFixed(0)} USDC on ${config.supportedChains.map((c) => c.label).join(", ")}...`,
  });

  // Snapshot initial balances for delta detection
  const initialByChain: Record<string, bigint> = {};
  if (existing?.initial_balances_by_chain) {
    for (const [cid, val] of Object.entries(existing.initial_balances_by_chain)) {
      initialByChain[cid] = BigInt(String(val));
    }
  } else {
    for (const chain of config.supportedChains) {
      try {
        initialByChain[chain.id] = await balance.getUsdcBalance(jobData.agentWallet, chain.id);
      } catch {
        initialByChain[chain.id] = 0n;
      }
    }
    const serialized: Record<string, string> = {};
    for (const [cid, val] of Object.entries(initialByChain)) {
      serialized[cid] = val.toString();
    }
    await state.updateJob(jobData.jobId, { initial_balances_by_chain: serialized });
  }

  const start = Date.now();
  while (Date.now() - start < config.depositTimeoutMs) {
    if (await cancellation.isCancelled(jobData.jobId)) {
      throw new JobCancelledError(jobData.jobId);
    }

    // Poll all chains in parallel
    const snapshots = await Promise.all(
      config.supportedChains.map(async (chain) => {
        try {
          const bal = await balance.getUsdcBalance(jobData.agentWallet, chain.id);
          return { chainId: chain.id, label: chain.label, balance: bal };
        } catch {
          return { chainId: chain.id, label: chain.label, balance: 0n };
        }
      }),
    );

    // Find best chain by delta
    let bestChain: { chainId: string; label: string; delta: bigint } | null = null;
    for (const s of snapshots) {
      const init = initialByChain[s.chainId] ?? 0n;
      const delta = s.balance - init;
      if (delta <= 0n) continue;
      if (!bestChain || delta > bestChain.delta) {
        bestChain = { chainId: s.chainId, label: s.label, delta };
      }
    }

    // Prefer target chain (no bridge needed)
    const targetSnap = snapshots.find((s) => s.chainId === config.targetChainId);
    const targetInit = initialByChain[config.targetChainId] ?? 0n;
    const targetDelta = targetSnap ? targetSnap.balance - targetInit : 0n;
    const targetDeltaUsdc = Number(targetDelta > 0n ? targetDelta : 0n) / 1e6;

    if (targetDeltaUsdc >= targetUsdc) {
      logger.info(`[funding] Threshold met on target chain: $${targetDeltaUsdc.toFixed(2)}`);
      await state.updateJob(jobData.jobId, { deposit_usdc_amount: targetDelta.toString(), source_chain_id: config.targetChainId });
      events.emit({ jobId: jobData.jobId, state: "waiting_deposit", progress: 15, message: `Received $${targetDeltaUsdc.toFixed(2)} USDC` });
      return { chainId: config.targetChainId, usdcAmount: targetDelta };
    }

    if (bestChain) {
      const bestDeltaUsdc = Number(bestChain.delta) / 1e6;
      if (bestDeltaUsdc >= targetUsdc) {
        logger.info(`[funding] Threshold met on ${bestChain.label}: $${bestDeltaUsdc.toFixed(2)}`);
        await state.updateJob(jobData.jobId, { deposit_usdc_amount: bestChain.delta.toString(), source_chain_id: bestChain.chainId });
        events.emit({ jobId: jobData.jobId, state: "waiting_deposit", progress: 15, message: `Received $${bestDeltaUsdc.toFixed(2)} USDC on ${bestChain.label} (will bridge via CCTP)` });
        return { chainId: bestChain.chainId, usdcAmount: bestChain.delta };
      }
    }

    await new Promise((r) => setTimeout(r, config.depositPollIntervalMs));
  }

  throw new Error(`USDC deposit timeout after ${config.depositTimeoutMs / 60000} minutes`);
}
