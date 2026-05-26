/**
 * X402 Client — Framework-Agnostic EIP-3009 Signing
 *
 * Core signing logic for X402 payments. Works with any wallet provider
 * that implements the X402Signer interface (wagmi, ethers, viem, Moon SDK, etc.)
 *
 * The X402Signer interface is intentionally minimal — it maps directly to
 * EIP-712 signTypedData, which every wallet provider supports.
 */

import type { SignedAuthorizationWithSig } from "../types/protocol";

// ============================================================================
// Signer Interface
// ============================================================================

/**
 * EIP-712 domain separator fields for typed data signing.
 *
 * @see https://eips.ethereum.org/EIPS/eip-712
 */
export interface EIP712Domain {
  /** The user-readable name of the signing domain (e.g., "USD Coin"). */
  name: string;
  /** The version of the signing domain (e.g., "2"). */
  version: string;
  /** The EVM chain ID where the contract is deployed. */
  chainId: number;
  /** The contract address that will verify the signature. */
  verifyingContract: string;
}

/**
 * Abstract wallet signer for X402 payments.
 *
 * Implement this interface to integrate any wallet provider:
 * - wagmi: `{ signTypedData: walletClient.signTypedData }`
 * - ethers: wrap `signer._signTypedData(domain, types, value)`
 * - Moon SDK: wrap the `/sign-typed-data` API endpoint
 */
export interface X402Signer {
  /** The signer's address (checksummed). */
  address: string;

  /**
   * Sign EIP-712 typed data and return the hex signature.
   *
   * @param params - The EIP-712 typed data parameters.
   * @param params.domain - The EIP-712 domain separator.
   * @param params.types - The type definitions for the structured data.
   * @param params.primaryType - The primary type being signed (e.g., `"TransferWithAuthorization"`).
   * @param params.message - The message values to sign.
   * @returns A hex-encoded signature string (65 bytes, starting with `0x`).
   */
  signTypedData(params: {
    domain: EIP712Domain;
    types: Record<string, Array<{ name: string; type: string }>>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<string>;
}

// ============================================================================
// Constants
// ============================================================================

/** EIP-712 types for EIP-3009 TransferWithAuthorization */
export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** Default validity window: -10 minutes to +5 minutes from now. */
export const DEFAULT_VALIDITY_WINDOW = {
  beforeSeconds: 600,
  afterSeconds: 300,
} as const;

// ============================================================================
// Core Functions
// ============================================================================

/** Generate a cryptographically random 32-byte nonce as a hex string. */
export function generateNonce(): string {
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);
  return `0x${Array.from(randomBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
}

/**
 * Build an EIP-712 domain separator for a USDC contract on a given chain.
 *
 * @param chainId - The EVM chain ID (e.g., 8453 for Base).
 * @param usdcAddress - The USDC contract address on this chain.
 * @param tokenName - The EIP-712 token name from the contract (typically `"USD Coin"`).
 * @param tokenVersion - The EIP-712 token version from the contract (typically `"2"`).
 * @returns A fully populated {@link EIP712Domain} object.
 *
 * @example
 * ```typescript
 * const domain = buildEIP712Domain(8453, "0x833589f...", "USD Coin", "2");
 * ```
 */
export function buildEIP712Domain(
  chainId: number,
  usdcAddress: string,
  tokenName: string,
  tokenVersion: string,
): EIP712Domain {
  return {
    name: tokenName,
    version: tokenVersion,
    chainId,
    verifyingContract: usdcAddress,
  };
}

/**
 * Parse a combined 65-byte hex signature into its `v`, `r`, `s` components.
 *
 * The signature must be a `0x`-prefixed hex string of exactly 130 hex characters
 * (65 bytes): 32 bytes for `r`, 32 bytes for `s`, and 1 byte for `v`.
 *
 * @param signature - The combined hex signature (e.g., `"0x1234...abcd1b"`).
 * @returns An object with `{ v, r, s }` where `r` and `s` are `0x`-prefixed hex strings.
 * @throws {Error} If the signature is not a valid hex string or has incorrect length.
 *
 * @example
 * ```typescript
 * const { v, r, s } = parseSignature("0x" + "ab".repeat(32) + "cd".repeat(32) + "1b");
 * // v = 27, r = "0xabab...abab", s = "0xcdcd...cdcd"
 * ```
 */
export function parseSignature(signature: string): {
  v: number;
  r: string;
  s: string;
} {
  if (!signature || !signature.startsWith("0x")) {
    throw new Error("Signature must be a hex string starting with 0x");
  }
  const hex = signature.slice(2);
  if (hex.length !== 130) {
    throw new Error(
      `Invalid signature length: expected 130 hex chars (65 bytes), got ${hex.length}`,
    );
  }
  const r = `0x${hex.slice(0, 64)}`;
  const s = `0x${hex.slice(64, 128)}`;
  const v = parseInt(hex.slice(128, 130), 16);
  if (Number.isNaN(v)) {
    throw new Error("Invalid v component in signature");
  }
  return { v, r, s };
}

/**
 * Sign an EIP-3009 TransferWithAuthorization using the provided signer.
 *
 * This is the core signing function — framework-agnostic. It:
 * 1. Builds the EIP-712 domain from the USDC contract address
 * 2. Constructs the TransferWithAuthorization message
 * 3. Signs it via the injected signer
 * 4. Parses the signature into v, r, s components
 *
 * @param signer - An {@link X402Signer} implementation (wagmi, ethers, etc.).
 * @param params - Transfer authorization parameters.
 * @param params.from - The payer address (must match the signer's address).
 * @param params.to - The recipient (payTo) address.
 * @param params.value - The USDC amount in atomic units.
 * @param params.validAfter - Unix timestamp after which the authorization is valid.
 * @param params.validBefore - Unix timestamp before which the authorization is valid.
 * @param params.nonce - A unique 32-byte hex nonce to prevent replay.
 * @param params.usdcAddress - The USDC contract address on the target chain.
 * @param params.tokenName - The EIP-712 token name (e.g., "USD Coin").
 * @param params.tokenVersion - The EIP-712 token version (e.g., "2").
 * @param params.chainId - The EVM chain ID.
 * @returns The signed authorization with all fields needed for on-chain settlement.
 */
export async function signTransferAuthorization(
  signer: X402Signer,
  params: {
    from: string;
    to: string;
    value: bigint;
    validAfter: bigint;
    validBefore: bigint;
    nonce: string;
    usdcAddress: string;
    tokenName: string;
    tokenVersion: string;
    chainId: number;
  },
): Promise<SignedAuthorizationWithSig> {
  const domain = buildEIP712Domain(
    params.chainId,
    params.usdcAddress,
    params.tokenName,
    params.tokenVersion,
  );

  const message = {
    from: params.from,
    to: params.to,
    value: params.value,
    validAfter: params.validAfter,
    validBefore: params.validBefore,
    nonce: params.nonce,
  };

  const signature = await signer.signTypedData({
    domain,
    types: { ...TRANSFER_WITH_AUTHORIZATION_TYPES },
    primaryType: "TransferWithAuthorization",
    message,
  });

  const { v, r, s } = parseSignature(signature);

  return {
    from: params.from,
    to: params.to,
    value: params.value,
    validAfter: params.validAfter,
    validBefore: params.validBefore,
    nonce: params.nonce,
    v,
    r,
    s,
  };
}

/**
 * Create a validity window for a payment authorization.
 *
 * Returns `{ validAfter, validBefore }` as `bigint` Unix timestamps.
 * The default window is -10 minutes to +5 minutes from the current time.
 *
 * @param options - Optional overrides for the validity window.
 * @param options.beforeSeconds - Seconds before `now` for `validAfter`. Default: `600` (10 min).
 * @param options.afterSeconds - Seconds after `now` for `validBefore`. Default: `300` (5 min).
 * @returns An object with `{ validAfter, validBefore }` as `bigint` Unix timestamps.
 *
 * @example
 * ```typescript
 * const { validAfter, validBefore } = createValidityWindow();
 * // validAfter  = now - 600 seconds
 * // validBefore = now + 300 seconds
 *
 * const custom = createValidityWindow({ beforeSeconds: 60, afterSeconds: 120 });
 * ```
 */
export function createValidityWindow(options?: {
  beforeSeconds?: number;
  afterSeconds?: number;
}): { validAfter: bigint; validBefore: bigint } {
  const before = options?.beforeSeconds ?? DEFAULT_VALIDITY_WINDOW.beforeSeconds;
  const after = options?.afterSeconds ?? DEFAULT_VALIDITY_WINDOW.afterSeconds;
  const now = Math.floor(Date.now() / 1000);
  return {
    validAfter: BigInt(now - before),
    validBefore: BigInt(now + after),
  };
}
