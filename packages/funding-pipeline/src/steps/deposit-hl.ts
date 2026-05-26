/**
 * Step: Deposit to Exchange (Hyperliquid)
 *
 * Deposits remaining USDC from the agent wallet to the trading exchange.
 * Skips if the remaining amount is below the minimum deposit threshold.
 *
 * @packageDocumentation
 */

import type { FundingConfig, FundingJobData } from "../types";
import type {
  UsdcBalanceProvider,
  DepositProvider,
  FundingEventEmitter,
  StateStore,
  FundingLogger,
} from "../interfaces";

/**
 * Deposit remaining USDC from the agent wallet into the trading exchange.
 *
 * Reads the current USDC balance on the target chain and deposits it to
 * the exchange (e.g. Hyperliquid). If the balance is below
 * `config.exchangeMinDeposit`, the deposit is skipped with a log message.
 *
 * **Idempotency**: If `existing.hl_deposit_tx_hash` is already set, returns
 * immediately without making another deposit.
 *
 * @param params - Step parameters including job data, config, and provider dependencies.
 * @param params.jobData - The funding job being processed.
 * @param params.config - Pipeline configuration (target chain, minimum deposit threshold).
 * @param params.deposit - Provider for depositing USDC to the exchange.
 * @param params.balance - Provider for reading the agent wallet's USDC balance.
 * @param params.events - Event emitter for progress updates.
 * @param params.state - State store for persisting the deposit transaction hash.
 * @param params.logger - Logger instance.
 * @param params.existing - Previously persisted state for idempotent resume (optional).
 * @throws {Error} If the exchange deposit operation returns `success: false`.
 */
export async function stepDepositToExchange(params: {
  jobData: FundingJobData;
  config: FundingConfig;
  deposit: DepositProvider;
  balance: UsdcBalanceProvider;
  events: FundingEventEmitter;
  state: StateStore;
  logger: FundingLogger;
  existing?: any;
}): Promise<void> {
  const { jobData, config, deposit, balance, events, state, logger, existing } = params;

  if (existing?.hl_deposit_tx_hash) {
    logger.info(`[funding] Exchange deposit already complete: ${existing.hl_deposit_tx_hash}`);
    return;
  }

  events.emit({ jobId: jobData.jobId, state: "depositing_exchange", progress: 80, message: "Depositing USDC to exchange..." });

  const usdcBalanceRaw = await balance.getUsdcBalance(
    jobData.agentWallet,
    config.targetChainId,
  );
  const usdcBalance = Number(usdcBalanceRaw) / 1e6;

  if (usdcBalance < config.exchangeMinDeposit) {
    logger.info(`[funding] USDC balance ${usdcBalance.toFixed(2)} below minimum ${config.exchangeMinDeposit} — skipping deposit`);
    events.emit({ jobId: jobData.jobId, state: "depositing_exchange", progress: 90, message: "Balance below minimum — skipping exchange deposit" });
    return;
  }

  const result = await deposit.deposit({
    wallet: jobData.agentWallet,
    amount: usdcBalance,
  });

  if (!result.success) {
    throw new Error(`Exchange deposit failed for ${usdcBalance.toFixed(2)} USDC`);
  }

  await state.updateJob(jobData.jobId, { hl_deposit_tx_hash: result.txHash });
  events.emit({
    jobId: jobData.jobId,
    state: "depositing_exchange",
    progress: 95,
    message: `Deposited ${usdcBalance.toFixed(2)} USDC to exchange`,
    txHashes: { exchangeDeposit: result.txHash },
  });
}
