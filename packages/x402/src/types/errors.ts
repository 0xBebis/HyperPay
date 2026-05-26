/**
 * X402 Error Types
 *
 * Typed error codes and a custom error class for X402 payment failures.
 * These are thrown by client-side signing flows and React hooks.
 */

/**
 * Machine-readable error codes for X402 payment failures.
 *
 * Used as the `code` property on {@link X402Error} to enable programmatic
 * error handling without relying on message string matching.
 */
export enum X402ErrorCode {
  /** No wallet is connected to the application. */
  WALLET_NOT_CONNECTED = "WALLET_NOT_CONNECTED",
  /** Wallet client exists but is not yet ready to sign. */
  WALLET_CLIENT_NOT_READY = "WALLET_CLIENT_NOT_READY",
  /** The payment authorization has expired (`validBefore` is in the past). */
  PAYMENT_EXPIRED = "PAYMENT_EXPIRED",
  /** The wallet does not have enough USDC to cover the payment. */
  INSUFFICIENT_BALANCE = "INSUFFICIENT_BALANCE",
  /** The EIP-3009 signature is invalid or malformed. */
  INVALID_SIGNATURE = "INVALID_SIGNATURE",
  /** The wallet is connected to the wrong network. */
  NETWORK_MISMATCH = "NETWORK_MISMATCH",
  /** Failed to switch the wallet to the required network. */
  NETWORK_SWITCH_FAILED = "NETWORK_SWITCH_FAILED",
  /** The facilitator rejected the payment signature during verification. */
  PAYMENT_VERIFICATION_FAILED = "PAYMENT_VERIFICATION_FAILED",
  /** The on-chain settlement transaction failed. */
  PAYMENT_SETTLEMENT_FAILED = "PAYMENT_SETTLEMENT_FAILED",
  /** The payment requirements from the server are malformed or missing fields. */
  INVALID_REQUIREMENTS = "INVALID_REQUIREMENTS",
  /** No agent wallet is configured for AI-agent payments. */
  NO_AGENT_WALLET = "NO_AGENT_WALLET",
  /** An error occurred in the agent SDK during payment signing. */
  AGENT_SDK_ERROR = "AGENT_SDK_ERROR",
  /** Failed to encode or decode the X-Payment header. */
  ENCODING_ERROR = "ENCODING_ERROR",
  /** An unexpected error occurred. */
  UNKNOWN_ERROR = "UNKNOWN_ERROR",
}

/**
 * Custom error class for X402 payment failures.
 *
 * Extends the native `Error` with a typed {@link X402ErrorCode} and optional
 * `details` payload for programmatic error handling.
 *
 * @example
 * ```typescript
 * try {
 *   await handlePaymentRequired(requirements);
 * } catch (err) {
 *   if (err instanceof X402Error && err.code === X402ErrorCode.INSUFFICIENT_BALANCE) {
 *     showTopUpDialog();
 *   }
 * }
 * ```
 */
export class X402Error extends Error {
  /** Machine-readable error code identifying the failure type. */
  code: X402ErrorCode;
  /** Optional additional context about the error. */
  details?: unknown;

  /**
   * Create a new X402Error.
   *
   * @param code - The error code from {@link X402ErrorCode}.
   * @param message - A human-readable error message.
   * @param details - Optional additional data for debugging.
   */
  constructor(code: X402ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "X402Error";
    this.code = code;
    this.details = details;
  }
}
