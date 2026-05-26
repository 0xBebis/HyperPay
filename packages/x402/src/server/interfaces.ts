/**
 * X402 Server — Pluggable Interfaces
 *
 * These interfaces decouple the X402 payment library from any specific
 * database or facilitator implementation. Implement them to integrate
 * X402 with your own persistence layer and settlement service.
 */

import type {
  X402PaymentConfig,
  X402PaymentPayload,
  X402PaymentRequirement,
  X402VerificationResult,
  X402SettlementResult,
} from "../types/protocol";

// ============================================================================
// Payment Persistence
// ============================================================================

/**
 * A previously completed payment record returned by {@link PaymentPersistence.findExistingPayment}.
 */
export interface ExistingPaymentRecord {
  /** Unique identifier for the payment record. */
  id: string;
  /** Current status of the payment (e.g., "verified", "settled"). */
  status: string;
  /** ISO 8601 timestamp of when the payment was created. */
  created_at: string;
  /** The payment amount in USDC (human-readable, e.g., `0.10`). */
  amount_usdc: number;
  /** The on-chain settlement transaction hash, or `null` if not yet settled. */
  tx_hash: string | null;
}

/**
 * Parameters for logging a payment transaction via {@link PaymentPersistence.logTransaction}.
 */
export interface TransactionLogParams {
  /** The type of resource being paid for (e.g., "credit_purchase", "analysis"). */
  resourceType: string;
  /** Optional identifier for the specific resource instance. */
  resourceId?: string;
  /** The decoded X402 payment payload from the client. */
  paymentPayload: X402PaymentPayload;
  /** The payment requirements that the client fulfilled. */
  paymentRequirements: X402PaymentRequirement;
  /** Current status of the transaction (e.g., "verified", "settled", "error"). */
  status: string;
  /** The on-chain settlement transaction hash, or `null` if not yet settled. */
  txHash: string | null;
  /** The blockchain network name (e.g., "base", "arbitrum"). */
  network: string;
  /** The EVM chain ID (e.g., 8453 for Base). */
  chainId?: number;
  /** The payer's Ethereum address. */
  payerAddress: string;
  /** The recipient's Ethereum address. */
  recipientAddress: string;
  /** The payment amount in atomic units (wei-like string). */
  amountWei: string;
  /** The authenticated user ID of the payer, if available. */
  payerUserId?: string;
  /** The bot ID if the payment was made by an AI agent. */
  payerBotId?: string;
  /** The user ID of the payment recipient, if available. */
  recipientUserId?: string;
  /** Error message if the transaction failed. */
  errorMessage?: string;
}

/**
 * Abstract persistence layer for X402 payments.
 *
 * Implement this interface to store payment records in your database:
 * - Supabase, PostgreSQL, DynamoDB, Redis, etc.
 *
 * The X402PaymentLibrary delegates all storage operations to this interface.
 */
export interface PaymentPersistence {
  /**
   * Find an existing completed payment for a resource by a user.
   *
   * Used in `permanent` access mode to grant access without re-payment.
   *
   * @param params - Search parameters.
   * @param params.resourceType - The type of resource (e.g., "credit_purchase").
   * @param params.resourceId - The specific resource identifier.
   * @param params.payerUserId - The user ID of the payer.
   * @param params.statuses - Optional list of acceptable statuses (default: any).
   * @returns The matching payment record, or `null` if none exists.
   */
  findExistingPayment(params: {
    resourceType: string;
    resourceId: string;
    payerUserId: string;
    statuses?: string[];
  }): Promise<ExistingPaymentRecord | null>;

  /**
   * Log a new payment transaction to the persistence layer.
   *
   * @param params - The transaction details to log. See {@link TransactionLogParams}.
   * @returns The generated transaction ID, or `null` if logging failed.
   */
  logTransaction(params: TransactionLogParams): Promise<string | null>;

  /**
   * Update the status of an existing transaction (e.g., `"verified"` to `"settled"`).
   *
   * @param id - The transaction ID to update.
   * @param status - The new status value.
   * @param result - Optional additional result data to store (e.g., settlement details).
   */
  updateTransactionStatus(
    id: string,
    status: string,
    result?: Record<string, unknown>,
  ): Promise<void>;

  /**
   * Retrieve a stored payment configuration for a resource type and endpoint.
   *
   * Used to reconstruct payment requirements on subsequent requests.
   *
   * @param resourceType - The type of resource (e.g., "credit_purchase").
   * @param endpointPath - The API endpoint path (e.g., "/api/v1/premium").
   * @param network - Optional network filter (e.g., "base").
   * @returns The matching payment config, or `null` if not found.
   */
  getPaymentConfig(
    resourceType: string,
    endpointPath: string,
    network?: string,
  ): Promise<X402PaymentConfig | null>;

  /**
   * Store a payment configuration for future reference.
   *
   * @param config - The {@link X402PaymentConfig} to persist.
   */
  savePaymentConfig(config: X402PaymentConfig): Promise<void>;
}

// ============================================================================
// Facilitator Client
// ============================================================================

/**
 * Abstract facilitator client for X402 payment verification and settlement.
 *
 * The facilitator is an external service that:
 * 1. Cryptographically verifies EIP-3009 signatures
 * 2. Executes `transferWithAuthorization` on-chain to settle the payment
 *
 * The default implementation calls Coinbase's facilitator at
 * https://facilitator.payai.network. You can implement your own
 * facilitator or use a different settlement service.
 */
export interface FacilitatorClient {
  /**
   * Verify a payment signature is valid without executing it on-chain.
   *
   * @param payload - The decoded X402 payment payload from the client.
   * @param requirements - The payment requirements the payload must satisfy.
   * @returns A verification result indicating validity and any error reason.
   */
  verify(
    payload: X402PaymentPayload,
    requirements: X402PaymentRequirement,
  ): Promise<X402VerificationResult>;

  /**
   * Verify AND execute the payment on-chain.
   *
   * Calls `transferWithAuthorization` to settle the EIP-3009 payment.
   *
   * @param payload - The decoded X402 payment payload from the client.
   * @param requirements - The payment requirements the payload must satisfy.
   * @returns A settlement result containing the transaction hash on success.
   */
  settle(
    payload: X402PaymentPayload,
    requirements: X402PaymentRequirement,
  ): Promise<X402SettlementResult>;
}

// ============================================================================
// Middleware Options
// ============================================================================

/** Payment access mode controlling how repeat access to a resource is handled. */
export type AccessMode = "permanent" | "per_use" | "subscription";

/**
 * Configuration options for the X402 Express middleware.
 *
 * Passed to {@link createX402Middleware} to control how a protected endpoint
 * handles payment requirements, verification, and settlement.
 */
export interface X402MiddlewareOptions {
  /** The type of resource being protected (e.g., "credit_purchase", "analysis"). */
  resourceType: string;

  /** Access mode: `"permanent"` (one-time buy), `"per_use"` (every request), `"subscription"`. Default: `"per_use"`. */
  accessMode?: AccessMode;

  /** Extract the resource ID from the request (used for permanent access deduplication). */
  getResourceId?: (req: any) => string;

  /** Get the payment destination address. Can be async and dynamic per-request. */
  getPayToAddress: (req: any) => Promise<string> | string;

  /** Get the payment amount in USDC. Can be async and dynamic per-request. */
  getAmount: (req: any) => Promise<number> | number;

  /** Extract the authenticated user ID from the request. */
  getUserId?: (req: any) => string | undefined;

  /** Optional structured logger. Falls back to `console` if not provided. */
  logger?: {
    /** Log informational messages. */
    info: (...args: unknown[]) => void;
    /** Log error messages. */
    error: (...args: unknown[]) => void;
    /** Log warning messages. */
    warn: (...args: unknown[]) => void;
  };
}
