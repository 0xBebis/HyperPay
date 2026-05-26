/**
 * Funding Pipeline -- CCTP-Native Provider Interfaces
 *
 * Implement these interfaces to integrate the funding pipeline with
 * your own infrastructure. The pipeline is USDC-only and uses Circle
 * CCTP for cross-chain bridging -- no ETH swaps or generic bridge
 * aggregators needed.
 *
 * @packageDocumentation
 */

import type { FundingProgress } from "./types";

// ============================================================================
// USDC Balance Provider
// ============================================================================

/**
 * Read USDC balances across chains.
 * Used to detect deposits and verify credit transfers.
 */
export interface UsdcBalanceProvider {
  /**
   * Read the USDC balance of a wallet on a specific chain.
   *
   * @param wallet - EVM wallet address to query.
   * @param chainId - Chain identifier (e.g. "42161" for Arbitrum, "999" for Hypercore).
   * @returns USDC balance in atomic units (6 decimals, i.e. 1 USDC = 1_000_000n).
   *
   * @example
   * ```ts
   * const balance = await provider.getUsdcBalance("0x1234...abcd", "42161");
   * const humanReadable = Number(balance) / 1e6; // e.g. 100.50
   * ```
   */
  getUsdcBalance(wallet: string, chainId: string): Promise<bigint>;
}

// ============================================================================
// CCTP Bridge Provider
// ============================================================================

/**
 * Execute Circle CCTP cross-chain USDC transfers.
 *
 * CCTP works in three steps:
 * 1. **Burn**: Call TokenMessenger.depositForBurn() on the source chain
 * 2. **Attest**: Wait for Circle's attestation service to sign the burn message
 * 3. **Mint**: Call MessageTransmitter.receiveMessage() on the destination chain
 *
 * For Hypercore (Hyperliquid), step 1 uses `sendToEvmWithData()` instead of
 * TokenMessenger, and steps 2-3 are handled by Hyperliquid's bridge infrastructure.
 */
export interface CctpBridgeProvider {
  /**
   * Initiate a CCTP burn on the source chain.
   *
   * For standard EVM chains: calls `TokenMessenger.depositForBurn()`.
   * For Hypercore: calls `HLExchange.sendToEvmWithData()`.
   *
   * @param params - Burn parameters.
   * @param params.wallet - Wallet address initiating the burn.
   * @param params.sourceChainId - Chain ID where USDC will be burned.
   * @param params.destinationDomain - CCTP domain ID of the destination chain.
   * @param params.amount - USDC amount to burn in atomic units (6 decimals).
   * @param params.destinationRecipient - Wallet address that will receive the minted USDC.
   * @returns Object containing the burn transaction hash and optional CCTP nonce.
   * @throws If the burn transaction fails or is reverted.
   */
  burn(params: {
    wallet: string;
    sourceChainId: string;
    destinationDomain: number;
    amount: bigint;
    destinationRecipient: string;
  }): Promise<{ txHash: string; nonce?: number }>;

  /**
   * Fetch Circle attestation for a burn transaction.
   *
   * Polls the Circle Iris API for the attestation signature.
   * Returns `null` if the attestation service hasn't processed it yet.
   *
   * @param params - Attestation query parameters.
   * @param params.burnTxHash - Transaction hash of the burn on the source chain.
   * @param params.sourceChainId - Chain ID where the burn occurred.
   * @returns Attestation result with status, or `null` if not yet available.
   */
  getAttestation(params: {
    burnTxHash: string;
    sourceChainId: string;
  }): Promise<{
    /** Whether the attestation is still pending or complete. */
    status: "pending" | "complete";
    /** The attestation signature bytes (hex-encoded). Present when status is "complete". */
    attestation?: string;
    /** The CCTP message bytes (hex-encoded). Present when status is "complete". */
    message?: string;
    /** Keccak256 hash of the CCTP message. */
    messageHash?: string;
  } | null>;

  /**
   * Mint USDC on the destination chain using the attestation.
   *
   * Calls `MessageTransmitter.receiveMessage(message, attestation)` on the
   * destination chain to complete the CCTP transfer.
   *
   * @param params - Mint parameters.
   * @param params.attestation - Circle attestation signature (hex-encoded).
   * @param params.message - CCTP message bytes (hex-encoded).
   * @param params.destinationChainId - Chain ID where USDC will be minted.
   * @param params.wallet - Wallet address submitting the mint transaction.
   * @returns Object containing the mint transaction hash.
   * @throws If the mint transaction fails or is reverted.
   */
  mint(params: {
    attestation: string;
    message: string;
    destinationChainId: string;
    wallet: string;
  }): Promise<{ txHash: string }>;
}

// ============================================================================
// Transfer & Deposit Providers
// ============================================================================

/**
 * Execute USDC ERC-20 transfers (used for credit purchases).
 */
export interface TransferProvider {
  /**
   * Transfer USDC from the agent wallet to a recipient address.
   *
   * @param params - Transfer parameters.
   * @param params.wallet - Sender wallet address.
   * @param params.chainId - Chain ID to execute the transfer on.
   * @param params.tokenAddress - USDC contract address on the chain.
   * @param params.to - Recipient wallet address.
   * @param params.amount - USDC amount in human-readable units (e.g. 25 = $25 USDC, NOT atomic units).
   * @returns Object containing the transfer transaction hash.
   * @throws If the transfer transaction fails or is reverted.
   *
   * @example
   * ```ts
   * // Send $25 USDC to the credits collection wallet
   * const result = await provider.transfer({
   *   wallet: "0xAgent...",
   *   chainId: "42161",
   *   tokenAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
   *   to: "0xCollection...",
   *   amount: 25, // $25 USDC, not 25_000_000
   * });
   * ```
   */
  transfer(params: {
    wallet: string;
    chainId: string;
    tokenAddress: string;
    to: string;
    amount: number;
  }): Promise<{ txHash: string }>;
}

/**
 * Wait for on-chain transaction receipts.
 */
export interface TransactionReceiptProvider {
  /**
   * Wait for a transaction to be confirmed on-chain.
   *
   * @param txHash - The transaction hash to wait for.
   * @param chainId - Chain ID where the transaction was submitted.
   * @param timeoutMs - Maximum time to wait for confirmation in milliseconds.
   * @returns Object with the transaction status ("success" or "reverted").
   * @throws If the timeout is exceeded before the receipt is available.
   */
  waitForReceipt(
    txHash: string,
    chainId: string,
    timeoutMs: number,
  ): Promise<{ status: "success" | "reverted" }>;
}

/**
 * Deposit USDC to a trading exchange (e.g. Hyperliquid).
 */
export interface DepositProvider {
  /**
   * Deposit USDC from the agent wallet into the exchange.
   *
   * @param params - Deposit parameters.
   * @param params.wallet - Agent wallet address holding the USDC.
   * @param params.amount - USDC amount in human-readable units (e.g. 75.5 = $75.50 USDC, NOT atomic units).
   * @returns Object with the deposit transaction hash and success flag.
   * @throws If the deposit operation encounters an unrecoverable error.
   *
   * @example
   * ```ts
   * // Deposit $75.50 USDC to the exchange
   * const result = await provider.deposit({
   *   wallet: "0xAgent...",
   *   amount: 75.5, // $75.50 USDC, not 75_500_000
   * });
   * if (!result.success) throw new Error("Deposit failed");
   * ```
   */
  deposit(params: {
    wallet: string;
    amount: number;
  }): Promise<{ txHash: string; success: boolean }>;
}

// ============================================================================
// Credits Provider
// ============================================================================

/**
 * Grant platform credits to a user account.
 */
export interface CreditsProvider {
  /**
   * Grant platform credits to a user after a successful USDC payment.
   *
   * @param params - Credit grant parameters.
   * @param params.userId - Platform user ID to receive the credits.
   * @param params.credits - Number of credits to grant (e.g. 2500).
   * @param params.metadata - Arbitrary metadata for audit trail (jobId, agentId, txHash, etc.).
   * @returns Resolves when credits have been granted.
   * @throws If the credit grant fails (e.g. user not found, database error).
   */
  grantCredits(params: {
    userId: string;
    credits: number;
    metadata: Record<string, unknown>;
  }): Promise<void>;
}

// ============================================================================
// State Persistence
// ============================================================================

/**
 * Persist pipeline state for idempotent retries.
 *
 * The pipeline stores intermediate results (tx hashes, attestations, flags)
 * after each sub-step so that if the process crashes, rerunning the same
 * job resumes from the last completed checkpoint.
 */
export interface StateStore {
  /**
   * Load the persisted state for a job.
   *
   * @param jobId - Unique job identifier.
   * @returns The persisted state record, or `null` if no state exists for this job.
   */
  loadJob(jobId: string): Promise<Record<string, any> | null>;

  /**
   * Merge a partial update into the persisted state for a job.
   *
   * @param jobId - Unique job identifier.
   * @param patch - Key-value pairs to merge into the existing state.
   * @returns Resolves when the state has been persisted.
   */
  updateJob(jobId: string, patch: Record<string, any>): Promise<void>;
}

// ============================================================================
// Events & Cancellation
// ============================================================================

/**
 * Emit live progress events (e.g. via WebSocket/PubSub).
 *
 * The pipeline calls {@link FundingEventEmitter.emit} at every state
 * transition so consumers can render real-time funding status.
 */
export interface FundingEventEmitter {
  /**
   * Emit a progress event for the current pipeline state.
   *
   * @param progress - The progress payload including state, percentage, and message.
   */
  emit(progress: FundingProgress): void;
}

/**
 * Check if a funding job has been cancelled by the user.
 *
 * The pipeline polls this between steps to support graceful cancellation.
 */
export interface CancellationChecker {
  /**
   * Check whether a job has been marked as cancelled.
   *
   * @param jobId - Unique job identifier.
   * @returns `true` if the job has been cancelled and should stop processing.
   */
  isCancelled(jobId: string): Promise<boolean>;
}

// ============================================================================
// Logger
// ============================================================================

/**
 * Structured logger for the funding pipeline.
 *
 * Implementations should route to your application's logging infrastructure
 * (e.g. Winston, Pino, console).
 */
export interface FundingLogger {
  /**
   * Log an informational message.
   *
   * @param message - The log message.
   * @param meta - Optional structured metadata for the log entry.
   */
  info(message: string, meta?: Record<string, unknown>): void;

  /**
   * Log a warning message.
   *
   * @param message - The log message.
   * @param meta - Optional structured metadata for the log entry.
   */
  warn(message: string, meta?: Record<string, unknown>): void;

  /**
   * Log an error message.
   *
   * @param message - The log message.
   * @param meta - Optional structured metadata for the log entry.
   */
  error(message: string, meta?: Record<string, unknown>): void;
}

// ============================================================================
// Aggregate Providers
// ============================================================================

/**
 * All providers needed by the {@link FundingPipeline}.
 *
 * Pass this as the first argument to `new FundingPipeline(providers)`.
 */
export interface FundingProviders {
  /** Provider for reading USDC balances across chains. */
  balance: UsdcBalanceProvider;
  /** Provider for executing CCTP burn/attest/mint operations. */
  cctp: CctpBridgeProvider;
  /** Provider for ERC-20 USDC transfers (credit purchases). */
  transfer: TransferProvider;
  /** Provider for waiting on transaction receipts. */
  receipt: TransactionReceiptProvider;
  /** Provider for depositing USDC to the trading exchange. */
  deposit: DepositProvider;
  /** Provider for granting platform credits. */
  credits: CreditsProvider;
  /** Persistent state store for idempotent retries. */
  state: StateStore;
  /** Event emitter for real-time progress updates. */
  events: FundingEventEmitter;
  /** Cancellation checker for graceful job cancellation. */
  cancellation: CancellationChecker;
  /** Structured logger instance. */
  logger: FundingLogger;
}
