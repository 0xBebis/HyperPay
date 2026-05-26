/**
 * X402 Payment Protocol Types
 * HTTP 402 Payment Required implementation for premium content
 */

import type { Address, Hex } from "viem";
import { formatUnits, parseUnits } from "viem";

// ============================================================================
// Protocol Version
// ============================================================================

export const X402_VERSION = 1;

// ============================================================================
// Enums
// ============================================================================

export enum PaymentScheme {
  EXACT = "exact",
  UPTO = "upto",
}

export enum PaymentNetwork {
  ARBITRUM = "arbitrum",
  BASE = "base",
  BASE_SEPOLIA = "base-sepolia",
  ETHEREUM = "ethereum",
}

// ============================================================================
// Network Configuration
// ============================================================================

export interface NetworkConfig {
  chainId: number;
  usdcAddress: Address;
  usdcName: string;
  usdcVersion: string;
  rpcUrl: string;
  displayName: string;
  explorerUrl: string;
}

export const NETWORK_CONFIGS: Record<PaymentNetwork, NetworkConfig> = {
  [PaymentNetwork.ARBITRUM]: {
    chainId: 42161,
    usdcAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    usdcName: "USD Coin",
    usdcVersion: "2",
    rpcUrl: "https://arb1.arbitrum.io/rpc",
    displayName: "Arbitrum",
    explorerUrl: "https://arbiscan.io",
  },
  [PaymentNetwork.BASE]: {
    chainId: 8453,
    usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    usdcName: "USD Coin",
    usdcVersion: "2",
    rpcUrl: "https://mainnet.base.org",
    displayName: "Base",
    explorerUrl: "https://basescan.org",
  },
  [PaymentNetwork.BASE_SEPOLIA]: {
    chainId: 84532,
    usdcAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    usdcName: "USD Coin",
    usdcVersion: "2",
    rpcUrl: "https://sepolia.base.org",
    displayName: "Base Sepolia",
    explorerUrl: "https://sepolia.basescan.org",
  },
  [PaymentNetwork.ETHEREUM]: {
    chainId: 1,
    usdcAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    usdcName: "USD Coin",
    usdcVersion: "2",
    rpcUrl: "https://eth.llamarpc.com",
    displayName: "Ethereum",
    explorerUrl: "https://etherscan.io",
  },
};

// ============================================================================
// Payment Requirements (from 402 response)
// ============================================================================

export interface X402PaymentRequirement {
  scheme: PaymentScheme | string;
  network: PaymentNetwork | string;
  maxAmountRequired: string; // In atomic units (6 decimals for USDC)
  resource: string;
  description?: string;
  mimeType: string;
  outputSchema?: object | null;
  payTo: Address;
  maxTimeoutSeconds: number;
  asset: Address;
  extra?: {
    name?: string;
    version?: string;
  } | null;
}

export interface X402PaymentRequirements {
  x402Version: number;
  accepts: X402PaymentRequirement[];
  error?: string;
}

// ============================================================================
// EIP-3009 Transfer Authorization
// ============================================================================

export interface TransferAuthorizationInternal {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}

export interface TransferAuthorization {
  from: Address;
  to: Address;
  value: string; // String for JSON serialization
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}

export interface SignatureComponents {
  v: number;
  r: Hex;
  s: Hex;
}

export interface SignedAuthorizationWithSig
  extends TransferAuthorizationInternal,
    SignatureComponents {}

// ============================================================================
// Payment Payload (sent in X-Payment header)
// ============================================================================

export interface X402PaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  payload: {
    signature: Hex;
    authorization: TransferAuthorization;
  };
}

// ============================================================================
// Payment Response
// ============================================================================

export interface X402PaymentResponse {
  success: boolean;
  error: string | null;
  txHash: string | null;
  networkId: string | null;
}

// ============================================================================
// Payment Status
// ============================================================================

export type X402PaymentStatus =
  | "idle"
  | "connecting"
  | "checking_balance"
  | "signing"
  | "verifying"
  | "success"
  | "error";

export type PaymentMethod = "wallet" | "agent";

// ============================================================================
// Error Types
// ============================================================================

export enum X402ErrorCode {
  WALLET_NOT_CONNECTED = "WALLET_NOT_CONNECTED",
  WALLET_CLIENT_NOT_READY = "WALLET_CLIENT_NOT_READY",
  PAYMENT_EXPIRED = "PAYMENT_EXPIRED",
  INSUFFICIENT_BALANCE = "INSUFFICIENT_BALANCE",
  INVALID_SIGNATURE = "INVALID_SIGNATURE",
  NETWORK_MISMATCH = "NETWORK_MISMATCH",
  NETWORK_SWITCH_FAILED = "NETWORK_SWITCH_FAILED",
  PAYMENT_VERIFICATION_FAILED = "PAYMENT_VERIFICATION_FAILED",
  PAYMENT_SETTLEMENT_FAILED = "PAYMENT_SETTLEMENT_FAILED",
  INVALID_REQUIREMENTS = "INVALID_REQUIREMENTS",
  NO_AGENT_WALLET = "NO_AGENT_WALLET",
  AGENT_SDK_ERROR = "AGENT_SDK_ERROR",
  ENCODING_ERROR = "ENCODING_ERROR",
  UNKNOWN_ERROR = "UNKNOWN_ERROR",
}

export class X402Error extends Error {
  code: X402ErrorCode;
  details?: unknown;

  constructor(code: X402ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "X402Error";
    this.code = code;
    this.details = details;
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Convert USDC amount to atomic units (6 decimals)
 * Uses viem's parseUnits to avoid IEEE 754 floating-point precision bugs
 * (e.g. 0.1 * 1_000_000 = 99999.99999999999 in JS)
 */
export const usdcToAtomicUnits = (usdc: number): bigint => {
  return parseUnits(usdc.toFixed(6), 6);
};

/**
 * Convert atomic units to USDC amount
 * Uses viem's formatUnits for consistent precision handling
 */
export const atomicUnitsToUsdc = (atomicUnits: bigint | string): number => {
  const value =
    typeof atomicUnits === "string" ? BigInt(atomicUnits) : atomicUnits;
  return Number.parseFloat(formatUnits(value, 6));
};

/**
 * Format USDC amount for display
 */
export const formatUSDC = (
  amount: number,
  options?: { showSymbol?: boolean }
): string => {
  const formatted = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(amount);

  return options?.showSymbol !== false ? `$${formatted}` : formatted;
};

/**
 * Format address for display (0x1234...5678)
 */
export const formatAddress = (address: string): string => {
  if (!address || address.length < 10) return address || "N/A";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
};

/**
 * Parse network string to PaymentNetwork enum
 */
export const parseNetwork = (network: string): PaymentNetwork | null => {
  const normalizedNetwork = network.toLowerCase().replace("_", "-");

  const networkMap: Record<string, PaymentNetwork> = {
    arbitrum: PaymentNetwork.ARBITRUM,
    base: PaymentNetwork.BASE,
    "base-sepolia": PaymentNetwork.BASE_SEPOLIA,
    ethereum: PaymentNetwork.ETHEREUM,
    mainnet: PaymentNetwork.ETHEREUM,
  };

  return networkMap[normalizedNetwork] || null;
};

/**
 * Get network configuration
 */
export const getNetworkConfig = (
  network: PaymentNetwork | string
): NetworkConfig | null => {
  const parsedNetwork =
    typeof network === "string" ? parseNetwork(network) : network;
  if (!parsedNetwork) return null;
  return NETWORK_CONFIGS[parsedNetwork] || null;
};

/**
 * Get chain ID from network string
 */
export const getChainIdFromNetwork = (network: string): number => {
  const config = getNetworkConfig(network);
  if (!config) {
    throw new X402Error(
      X402ErrorCode.NETWORK_MISMATCH,
      `Unsupported network: ${network}`
    );
  }
  return config.chainId;
};

/**
 * Validate payment requirements
 */
export const validatePaymentRequirements = (
  requirements: X402PaymentRequirements
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

/**
 * Encode payment payload to base64 for X-Payment header
 */
export const encodePaymentHeader = (payload: X402PaymentPayload): string => {
  const jsonString = JSON.stringify(payload, (_key, value) => {
    if (typeof value === "bigint") {
      return value.toString();
    }
    return value;
  });
  return btoa(jsonString);
};

/**
 * Decode X-Payment header value
 */
export const decodePaymentHeader = (
  base64Header: string
): X402PaymentPayload | null => {
  try {
    const jsonString = atob(base64Header);
    return JSON.parse(jsonString);
  } catch {
    return null;
  }
};

/**
 * Generate payment summary for display
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
