/**
 * X402 Client Module
 *
 * Framework-agnostic client-side utilities for X402 payments:
 * - {@link signTransferAuthorization} -- EIP-3009 signing with any wallet provider
 * - {@link createPaymentPayload} -- Payment payload construction
 * - {@link ViemBalanceChecker} -- ERC20 balance checking via viem
 *
 * @module client
 */
export * from "./signing";
export * from "./payload";
export * from "./balance";
