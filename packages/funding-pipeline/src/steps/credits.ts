/**
 * Steps: Buy Credits, Confirm Credits, Grant Credits
 *
 * Three-step credit purchase flow:
 * 1. Transfer USDC to the credits collection wallet
 * 2. Wait for tx receipt + balance verification
 * 3. Grant platform credits via the credits provider
 *
 * Each step is independently idempotent -- persisted flags (`credits_tx_hash`,
 * `credits_confirmed`, `credits_granted`) allow safe retries after crashes.
 *
 * @packageDocumentation
 */

import type { FundingConfig, FundingJobData } from "../types";
import type {
  TransferProvider,
  TransactionReceiptProvider,
  UsdcBalanceProvider,
  CreditsProvider,
  FundingEventEmitter,
  StateStore,
  FundingLogger,
} from "../interfaces";

/**
 * Transfer USDC to the credits collection wallet.
 *
 * Sends `config.creditsUsdcCost` USDC from the agent wallet to the
 * collection wallet on the target chain. The transfer amount is in
 * human-readable USDC (e.g. 25 = $25).
 *
 * **Idempotency**: If `existing.credits_tx_hash` is already set, returns
 * the cached tx hash without broadcasting a new transaction.
 *
 * @param params - Step parameters including job data, config, and provider dependencies.
 * @param params.jobData - The funding job being processed.
 * @param params.config - Pipeline configuration (target chain, collection wallet, cost).
 * @param params.transfer - Provider for executing ERC-20 USDC transfers.
 * @param params.events - Event emitter for progress updates.
 * @param params.state - State store for persisting the transaction hash.
 * @param params.logger - Logger instance.
 * @param params.existing - Previously persisted state for idempotent resume (optional).
 * @returns The transaction hash of the credit purchase transfer.
 * @throws If the USDC transfer fails.
 */
export async function stepBuyCredits(params: {
  jobData: FundingJobData;
  config: FundingConfig;
  transfer: TransferProvider;
  events: FundingEventEmitter;
  state: StateStore;
  logger: FundingLogger;
  existing?: any;
}): Promise<string> {
  const { jobData, config, transfer, events, state, logger, existing } = params;

  if (existing?.credits_tx_hash) {
    logger.info(`[funding] Credits purchase already broadcast: ${existing.credits_tx_hash}`);
    return existing.credits_tx_hash;
  }

  events.emit({ jobId: jobData.jobId, state: "buying_credits", progress: 50, message: `Sending $${config.creditsUsdcCost} USDC for credits...` });

  const result = await transfer.transfer({
    wallet: jobData.agentWallet,
    chainId: config.targetChainId,
    tokenAddress: config.targetUsdcAddress,
    to: config.creditsCollectionWallet,
    amount: config.creditsUsdcCost,
  });

  await state.updateJob(jobData.jobId, { credits_tx_hash: result.txHash });
  events.emit({ jobId: jobData.jobId, state: "buying_credits", progress: 55, message: "Credits purchase broadcast — confirming..." });

  return result.txHash;
}

/**
 * Wait for the credit purchase transaction receipt and verify balances.
 *
 * Polls for the on-chain receipt of the credits transfer transaction, then
 * verifies that the collection wallet's USDC balance increased.
 *
 * **Idempotency**: If `existing.credits_confirmed` is already set, returns
 * immediately without waiting for a receipt.
 *
 * @param params - Step parameters including job data, config, and provider dependencies.
 * @param params.jobData - The funding job being processed.
 * @param params.config - Pipeline configuration (target chain, timeouts).
 * @param params.creditsTxHash - Transaction hash from the buy credits step.
 * @param params.receipt - Provider for waiting on transaction receipts.
 * @param params.balance - Provider for reading USDC balances.
 * @param params.events - Event emitter for progress updates.
 * @param params.state - State store for persisting the confirmation flag.
 * @param params.logger - Logger instance.
 * @param params.existing - Previously persisted state for idempotent resume (optional).
 * @throws {Error} If the credit purchase transaction was reverted on-chain.
 */
export async function stepConfirmCredits(params: {
  jobData: FundingJobData;
  config: FundingConfig;
  creditsTxHash: string;
  receipt: TransactionReceiptProvider;
  balance: UsdcBalanceProvider;
  events: FundingEventEmitter;
  state: StateStore;
  logger: FundingLogger;
  existing?: any;
}): Promise<void> {
  const { jobData, config, creditsTxHash, receipt, balance, events, state, logger, existing } = params;

  if (existing?.credits_confirmed) {
    logger.info(`[funding] Credits already confirmed`);
    return;
  }

  events.emit({ jobId: jobData.jobId, state: "confirming_credits", progress: 60, message: "Waiting for confirmation..." });

  const rcpt = await receipt.waitForReceipt(creditsTxHash, config.targetChainId, config.receiptTimeoutMs);
  if (rcpt.status !== "success") {
    throw new Error(`Credits purchase tx reverted: ${creditsTxHash}`);
  }

  // Verify collection wallet received the USDC
  const collectionBalanceRaw = await balance.getUsdcBalance(
    config.creditsCollectionWallet,
    config.targetChainId,
  );
  const collectionBalance = Number(collectionBalanceRaw) / 1e6;
  logger.info(`[funding] Collection wallet USDC balance: ${collectionBalance.toFixed(2)}`);

  // Persist confirmation for idempotency
  await state.updateJob(jobData.jobId, { credits_confirmed: true });

  events.emit({ jobId: jobData.jobId, state: "confirming_credits", progress: 65, message: "Credit payment confirmed on-chain" });
}

/**
 * Grant platform credits to the user's account.
 *
 * Calls the credits provider to add `config.creditsAmount` credits to the
 * user identified by `jobData.userId`. Includes audit metadata (jobId,
 * agentId, txHash).
 *
 * **Idempotency**: If `existing.credits_granted` is already set, returns
 * immediately without granting credits again.
 *
 * @param params - Step parameters including job data, config, and provider dependencies.
 * @param params.jobData - The funding job being processed.
 * @param params.config - Pipeline configuration (credits amount).
 * @param params.creditsTxHash - Transaction hash from the buy credits step (for metadata).
 * @param params.credits - Provider for granting platform credits.
 * @param params.events - Event emitter for progress updates.
 * @param params.state - State store for persisting the grant flag.
 * @param params.logger - Logger instance.
 * @param params.existing - Previously persisted state for idempotent resume (optional).
 * @throws If the credit grant operation fails.
 */
export async function stepGrantCredits(params: {
  jobData: FundingJobData;
  config: FundingConfig;
  creditsTxHash: string;
  credits: CreditsProvider;
  events: FundingEventEmitter;
  state: StateStore;
  logger: FundingLogger;
  existing?: any;
}): Promise<void> {
  const { jobData, config, creditsTxHash, credits, events, state, logger, existing } = params;

  if (existing?.credits_granted) {
    logger.info(`[funding] Credits already granted`);
    return;
  }

  events.emit({ jobId: jobData.jobId, state: "granting_credits", progress: 70, message: `Granting ${config.creditsAmount} credits...` });

  await credits.grantCredits({
    userId: jobData.userId,
    credits: config.creditsAmount,
    metadata: {
      source: "agent-funding",
      txHash: creditsTxHash,
      jobId: jobData.jobId,
      agentId: jobData.agentId,
    },
  });

  await state.updateJob(jobData.jobId, { credits_granted: true, credits_confirmed: true });
  events.emit({ jobId: jobData.jobId, state: "granting_credits", progress: 75, message: `${config.creditsAmount} credits granted` });
}
