/**
 * @cod3x/x402 - X402 Payment Protocol Library
 *
 * A TypeScript implementation of the X402 HTTP payment protocol for
 * EIP-3009 USDC payments. Provides client-side signing, server-side
 * verification/settlement, and React hooks for wallet integration.
 *
 * @packageDocumentation
 *
 * @example Client-side (browser)
 * ```typescript
 * import { signTransferAuthorization, createPaymentPayload, encodePaymentHeader } from "@cod3x/x402";
 * ```
 *
 * @example Server-side (Express)
 * ```typescript
 * import { createX402Middleware, X402PaymentLibrary, DefaultFacilitatorClient } from "@cod3x/x402/server";
 * ```
 *
 * @example React hook (wagmi)
 * ```typescript
 * import { useX402Payment } from "@cod3x/x402/react";
 * ```
 */
export * from "./types";
export * from "./client";
