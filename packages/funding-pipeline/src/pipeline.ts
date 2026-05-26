/**
 * Funding Pipeline -- CCTP-Native Orchestrator
 *
 * Runs the multi-step funding state machine for AI agent wallets:
 *   waiting_deposit -> bridging (CCTP) -> buying_credits ->
 *   confirming_credits -> granting_credits -> depositing_exchange -> complete
 *
 * Designed for agents on Hyperliquid that need to self-fund their compute:
 * 1. Agent earns USDC from trading on Hypercore
 * 2. CCTP bridges USDC to Base/Arbitrum for credit purchases
 * 3. Credits fuel AI inference (LLM calls, strategy generation)
 * 4. Agent continues trading with better strategies
 *
 * Every step is idempotent -- the pipeline loads persisted state before
 * each step and skips work that already completed. If the process crashes
 * mid-step, rerunning the pipeline resumes exactly where it left off.
 *
 * @packageDocumentation
 */

import type { FundingConfig, FundingJobData } from "./types";
import { DEFAULT_FUNDING_CONFIG } from "./types";
import type { FundingProviders } from "./interfaces";
import { FundingStepError, JobCancelledError, formatStepError, runStep } from "./utils/error";
import { stepWaitForDeposit } from "./steps/wait-deposit";
import { stepCctpBridge } from "./steps/bridge";
import { stepBuyCredits, stepConfirmCredits, stepGrantCredits } from "./steps/credits";
import { stepDepositToExchange } from "./steps/deposit-hl";

/**
 * Orchestrates the full CCTP-native funding pipeline for an AI trading agent.
 *
 * The pipeline runs a linear state machine through deposit detection, optional
 * CCTP bridging, optional credit purchase, and exchange deposit. Each step is
 * idempotent -- if the pipeline crashes and restarts, it resumes from the last
 * persisted checkpoint.
 *
 * @example
 * ```ts
 * const pipeline = new FundingPipeline(providers, {
 *   targetChainId: "42161",
 *   creditsUsdcCost: 25,
 *   creditsAmount: 2500,
 * });
 *
 * const result = await pipeline.run({
 *   jobId: "fund-abc123",
 *   userId: "user-456",
 *   agentId: "agent-789",
 *   agentWallet: "0x1234...abcd",
 *   amountUsdc: 100,
 *   buyCredits: true,
 * });
 * // result.success === true
 * ```
 */
export class FundingPipeline {
  /** Injected provider implementations for all pipeline operations. */
  private providers: FundingProviders;
  /** Merged configuration (defaults + caller overrides). */
  private config: FundingConfig;

  /**
   * Create a new FundingPipeline instance.
   *
   * @param providers - All provider implementations required by the pipeline.
   * @param config - Optional partial configuration overrides. Fields not specified
   *                 fall back to {@link DEFAULT_FUNDING_CONFIG}.
   */
  constructor(providers: FundingProviders, config?: Partial<FundingConfig>) {
    this.providers = providers;
    this.config = { ...DEFAULT_FUNDING_CONFIG, ...config };
  }

  /**
   * Run the full CCTP funding pipeline for an agent.
   *
   * Executes the following steps in order:
   * 1. **Wait for deposit** -- polls USDC balances across all supported chains
   * 2. **CCTP bridge** -- burns on source chain, attests, mints on target chain (skipped if deposit is on target chain)
   * 3. **Buy credits** -- transfers USDC to collection wallet (skipped if `buyCredits` is false or insufficient balance)
   * 4. **Confirm credits** -- waits for tx receipt and verifies balances
   * 5. **Grant credits** -- calls the credits provider to add credits to the user account
   * 6. **Deposit to exchange** -- deposits remaining USDC to the trading exchange
   *
   * @param jobData - The funding job parameters (jobId, userId, agentId, agentWallet, amountUsdc, buyCredits).
   * @returns Object with `success: true` and the `jobId` on completion.
   * @throws {JobCancelledError} If the job is cancelled mid-flight (non-retryable).
   * @throws {FundingStepError} If any step fails (wraps the underlying error with step name).
   * @throws {Error} If input validation fails (missing fields, invalid amounts).
   */
  async run(jobData: FundingJobData): Promise<{ success: boolean; jobId: string }> {
    const { logger, state, events, cancellation } = this.providers;
    const config = this.config;

    try {
      // Validate inputs before starting any work
      if (!jobData.jobId || !jobData.userId || !jobData.agentId || !jobData.agentWallet) {
        throw new Error("Missing required job data: jobId, userId, agentId, and agentWallet are all required");
      }
      if (jobData.amountUsdc <= 0) {
        throw new Error(`Invalid amountUsdc: ${jobData.amountUsdc}. Must be > 0.`);
      }
      if (!config.supportedChains.find((c) => c.id === config.targetChainId)) {
        throw new Error(`Target chain ${config.targetChainId} not found in supportedChains`);
      }

      if (await cancellation.isCancelled(jobData.jobId)) {
        throw new JobCancelledError(jobData.jobId);
      }

      const checkCancelled = async () => {
        if (await cancellation.isCancelled(jobData.jobId)) {
          throw new JobCancelledError(jobData.jobId);
        }
      };

      const existing = await state.loadJob(jobData.jobId);

      // ── Step 1: Wait for USDC deposit ───────────────────────────────
      await state.updateJob(jobData.jobId, { state: "waiting_deposit" });
      const deposit = await runStep(logger, jobData, "waiting_deposit", () =>
        stepWaitForDeposit({
          jobData,
          config,
          balance: this.providers.balance,
          cancellation,
          events,
          state,
          logger,
          existing,
        }),
      );

      await checkCancelled();

      // ── Step 2: CCTP Bridge (if not already on target chain) ────────
      if (deposit.chainId !== config.targetChainId) {
        await state.updateJob(jobData.jobId, { state: "bridging" });
        const bridgeExisting = await state.loadJob(jobData.jobId);
        await runStep(logger, jobData, "bridging", () =>
          stepCctpBridge({
            jobData,
            config,
            sourceChainId: deposit.chainId,
            usdcAmount: deposit.usdcAmount,
            cctp: this.providers.cctp,
            cancellation,
            events,
            state,
            logger,
            existing: bridgeExisting,
          }),
        );
        await checkCancelled();
      }

      // ── Steps 3-5: Buy + Confirm + Grant Credits (optional) ────────
      if (jobData.buyCredits) {
        // Check if we have enough USDC for credits
        const usdcOnTarget = await this.providers.balance.getUsdcBalance(
          jobData.agentWallet,
          config.targetChainId,
        );
        const usdcAvailable = Number(usdcOnTarget) / 1e6;

        if (usdcAvailable >= config.creditsUsdcCost) {
          await state.updateJob(jobData.jobId, { state: "buying_credits" });
          const buyExisting = await state.loadJob(jobData.jobId);
          const creditsTxHash = await runStep(logger, jobData, "buying_credits", () =>
            stepBuyCredits({
              jobData,
              config,
              transfer: this.providers.transfer,
              events,
              state,
              logger,
              existing: buyExisting,
            }),
          );

          await checkCancelled();

          await state.updateJob(jobData.jobId, { state: "confirming_credits" });
          const confirmExisting = await state.loadJob(jobData.jobId);
          await runStep(logger, jobData, "confirming_credits", () =>
            stepConfirmCredits({
              jobData,
              config,
              creditsTxHash,
              receipt: this.providers.receipt,
              balance: this.providers.balance,
              events,
              state,
              logger,
              existing: confirmExisting,
            }),
          );

          await checkCancelled();

          await state.updateJob(jobData.jobId, { state: "granting_credits" });
          const grantExisting = await state.loadJob(jobData.jobId);
          await runStep(logger, jobData, "granting_credits", () =>
            stepGrantCredits({
              jobData,
              config,
              creditsTxHash,
              credits: this.providers.credits,
              events,
              state,
              logger,
              existing: grantExisting,
            }),
          );

          await checkCancelled();
        } else {
          logger.warn(
            `[funding] Insufficient USDC for credits: $${usdcAvailable.toFixed(2)} < $${config.creditsUsdcCost}. Skipping credit purchase.`,
          );
        }
      }

      // ── Step 6: Deposit USDC to exchange ────────────────────────────
      await state.updateJob(jobData.jobId, { state: "depositing_exchange" });
      const depositExisting = await state.loadJob(jobData.jobId);
      await runStep(logger, jobData, "depositing_exchange", () =>
        stepDepositToExchange({
          jobData,
          config,
          deposit: this.providers.deposit,
          balance: this.providers.balance,
          events,
          state,
          logger,
          existing: depositExisting,
        }),
      );

      // ── Complete ────────────────────────────────────────────────────
      await state.updateJob(jobData.jobId, {
        state: "complete",
        progress: 100,
        completed_at: new Date().toISOString(),
      });
      events.emit({
        jobId: jobData.jobId,
        state: "complete",
        progress: 100,
        message: "Agent funded and ready to trade",
      });

      logger.info(`[funding] Job ${jobData.jobId} complete`);
      return { success: true, jobId: jobData.jobId };
    } catch (err) {
      if (err instanceof JobCancelledError) {
        logger.info(`[funding] Job ${jobData.jobId} was cancelled`);
        return { success: true, jobId: jobData.jobId };
      }

      const stepName = err instanceof FundingStepError ? err.step : "unknown";
      const message = err instanceof FundingStepError ? err.message : formatStepError(err);

      await state.updateJob(jobData.jobId, {
        state: "failed",
        progress: 0,
        error: `[step=${stepName}] ${message}`.slice(0, 4000),
        completed_at: new Date().toISOString(),
      });
      events.emit({
        jobId: jobData.jobId,
        state: "failed",
        progress: 0,
        message: `Failed at ${stepName}`,
      });

      throw err;
    }
  }
}
