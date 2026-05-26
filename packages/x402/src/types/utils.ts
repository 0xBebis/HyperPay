/**
 * X402 Utility Functions
 *
 * Pure utility functions for USDC amount conversion, payment header
 * encoding/decoding, and payment requirement validation.
 */

import { formatUnits, parseUnits } from "viem";
import type {
  X402PaymentPayload,
  X402PaymentRequirement,
  X402PaymentRequirements,
} from "./protocol";
import { getNetworkConfig } from "./network";

// ============================================================================
// Amount Conversion
// ============================================================================

/**
 * Convert a human-readable USDC amount to atomic units (6 decimals).
 *
 * Uses viem's `parseUnits` internally to avoid IEEE 754 floating-point precision
 * bugs (e.g., `0.1 * 1_000_000 = 99999.99999999999` in plain JS).
 *
 * @param usdc - The USDC amount as a floating-point number (e.g., `1.50`).
 * @returns The amount in atomic units as a `bigint` (e.g., `1500000n`).
 *
 * @example
 * ```typescript
 * usdcToAtomicUnits(0.10);  // 100000n
 * usdcToAtomicUnits(25);    // 25000000n
 * ```
 */
export const usdcToAtomicUnits = (usdc: number): bigint => {
  return parseUnits(usdc.toFixed(6), 6);
};

/**
 * Convert atomic units back to a human-readable USDC amount.
 *
 * Uses viem's `formatUnits` for consistent precision handling.
 *
 * @param atomicUnits - The amount in atomic units, as a `bigint` or numeric string.
 * @returns The USDC amount as a floating-point number (e.g., `1.5`).
 *
 * @example
 * ```typescript
 * atomicUnitsToUsdc(1500000n);    // 1.5
 * atomicUnitsToUsdc("25000000");  // 25
 * ```
 */
export const atomicUnitsToUsdc = (atomicUnits: bigint | string): number => {
  const value =
    typeof atomicUnits === "string" ? BigInt(atomicUnits) : atomicUnits;
  return Number.parseFloat(formatUnits(value, 6));
};

// ============================================================================
// Formatting
// ============================================================================

/**
 * Format a USDC amount for human-readable display.
 *
 * @param amount - The USDC amount as a number (e.g., `1.5`).
 * @param options - Formatting options.
 * @param options.showSymbol - Whether to prepend a `$` sign. Defaults to `true`.
 * @returns The formatted string (e.g., `"$1.50"` or `"1.50"`).
 *
 * @example
 * ```typescript
 * formatUSDC(1.5);                          // "$1.50"
 * formatUSDC(1.5, { showSymbol: false });   // "1.50"
 * formatUSDC(0.000123);                     // "$0.000123"
 * ```
 */
export const formatUSDC = (
  amount: number,
  options?: { showSymbol?: boolean },
): string => {
  const formatted = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(amount);
  return options?.showSymbol !== false ? `$${formatted}` : formatted;
};

/**
 * Format an Ethereum address for display by truncating the middle.
 *
 * @param address - The full Ethereum address (e.g., `"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"`).
 * @returns The truncated address (e.g., `"0x8335...2913"`), or `"N/A"` if empty.
 *
 * @example
 * ```typescript
 * formatAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
 * // "0x8335...2913"
 * ```
 */
export const formatAddress = (address: string): string => {
  if (!address || address.length < 10) return address || "N/A";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
};

// ============================================================================
// Payment Header Encoding/Decoding
// ============================================================================

/**
 * Encode a payment payload to a base64 string for the `X-Payment` HTTP header.
 *
 * Works in both Node.js (using `Buffer`) and browsers (using `btoa`).
 * Handles `bigint` serialization by converting to string during JSON encoding.
 *
 * @param payload - The {@link X402PaymentPayload} to encode.
 * @returns The base64-encoded JSON string.
 *
 * @example
 * ```typescript
 * const header = encodePaymentHeader(payload);
 * // "eyJ4NDAyVmVyc2lvbiI6MSwi..."
 * fetch(url, { headers: { "X-Payment": header } });
 * ```
 */
export const encodePaymentHeader = (payload: X402PaymentPayload): string => {
  const jsonString = JSON.stringify(payload, (_key, value) => {
    if (typeof value === "bigint") {
      return value.toString();
    }
    return value;
  });
  // Use Buffer in Node.js, btoa in browsers
  if (typeof Buffer !== "undefined") {
    return Buffer.from(jsonString, "utf-8").toString("base64");
  }
  return btoa(jsonString);
};

/**
 * Decode an `X-Payment` header value from base64 back into a payment payload.
 *
 * Works in both Node.js (using `Buffer`) and browsers (using `atob`).
 * Returns `null` if the header is malformed or cannot be parsed.
 *
 * @param base64Header - The base64-encoded `X-Payment` header value.
 * @returns The decoded {@link X402PaymentPayload}, or `null` on failure.
 *
 * @example
 * ```typescript
 * const payload = decodePaymentHeader(req.headers["x-payment"]);
 * if (!payload) {
 *   return res.status(400).json({ error: "Invalid X-Payment header" });
 * }
 * ```
 */
export const decodePaymentHeader = (
  base64Header: string,
): X402PaymentPayload | null => {
  try {
    const jsonString =
      typeof Buffer !== "undefined"
        ? Buffer.from(base64Header, "base64").toString("utf-8")
        : atob(base64Header);
    return JSON.parse(jsonString);
  } catch {
    return null;
  }
};

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate that payment requirements contain all required fields.
 *
 * Checks that at least one `accepts` entry exists and that every entry
 * has a `payTo`, `asset`, and `maxAmountRequired` field.
 *
 * @param requirements - The {@link X402PaymentRequirements} to validate.
 * @returns `true` if the requirements are structurally valid, `false` otherwise.
 *
 * @example
 * ```typescript
 * const valid = validatePaymentRequirements(response402Body);
 * if (!valid) {
 *   throw new Error("Malformed payment requirements from server");
 * }
 * ```
 */
export const validatePaymentRequirements = (
  requirements: X402PaymentRequirements,
): boolean => {
  if (!requirements.accepts || requirements.accepts.length === 0) {
    return false;
  }
  for (const requirement of requirements.accepts) {
    if (
      !requirement.payTo ||
      !requirement.asset ||
      !requirement.maxAmountRequired
    ) {
      return false;
    }
  }
  return true;
};

// ============================================================================
// Payment Summary
// ============================================================================

/**
 * Generate a human-readable payment summary from a single payment requirement.
 *
 * Useful for displaying payment details in UI confirmation dialogs.
 *
 * @param requirement - The {@link X402PaymentRequirement} to summarize.
 * @returns An object with formatted amounts, network info, and recipient details.
 *
 * @example
 * ```typescript
 * const summary = getPaymentSummary(requirements.accepts[0]);
 * console.log(`Pay ${summary.amount} on ${summary.networkDisplayName} to ${summary.recipientFormatted}`);
 * // "Pay $0.10 on Base to 0x8335...2913"
 * ```
 */
export const getPaymentSummary = (requirement: X402PaymentRequirement) => {
  const amountUsdc = atomicUnitsToUsdc(requirement.maxAmountRequired);
  const networkConfig = getNetworkConfig(requirement.network);

  return {
    amount: formatUSDC(amountUsdc),
    amountUsdc,
    amountRaw: requirement.maxAmountRequired,
    network: requirement.network,
    networkDisplayName: networkConfig?.displayName || requirement.network,
    chainId: networkConfig?.chainId,
    recipient: requirement.payTo,
    recipientFormatted: formatAddress(requirement.payTo),
    description: requirement.description,
    timeout: requirement.maxTimeoutSeconds,
    asset: requirement.asset,
    assetName: requirement.extra?.name || "USDC",
  };
};
