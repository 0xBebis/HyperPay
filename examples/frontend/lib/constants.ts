/**
 * Chain Configuration & Constants
 *
 * Centralized configuration for supported chains, token addresses,
 * and platform fees used across the bridging and billing UI.
 */

// ============================================================================
// Chain Information
// ============================================================================

export interface ChainInfo {
  id: number;
  name: string;
  nativeCurrency: string;
  explorerUrl: string;
  iconPath?: string;
}

export const SUPPORTED_CHAINS: Record<number, ChainInfo> = {
  1: {
    id: 1,
    name: "Ethereum",
    nativeCurrency: "ETH",
    explorerUrl: "https://etherscan.io",
  },
  137: {
    id: 137,
    name: "Polygon",
    nativeCurrency: "MATIC",
    explorerUrl: "https://polygonscan.com",
  },
  42161: {
    id: 42161,
    name: "Arbitrum",
    nativeCurrency: "ETH",
    explorerUrl: "https://arbiscan.io",
  },
  10: {
    id: 10,
    name: "Optimism",
    nativeCurrency: "ETH",
    explorerUrl: "https://optimistic.etherscan.io",
  },
  8453: {
    id: 8453,
    name: "Base",
    nativeCurrency: "ETH",
    explorerUrl: "https://basescan.org",
  },
  56: {
    id: 56,
    name: "BNB Smart Chain",
    nativeCurrency: "BNB",
    explorerUrl: "https://bscscan.com",
  },
  43114: {
    id: 43114,
    name: "Avalanche",
    nativeCurrency: "AVAX",
    explorerUrl: "https://snowtrace.io",
  },
  250: {
    id: 250,
    name: "Fantom",
    nativeCurrency: "FTM",
    explorerUrl: "https://ftmscan.com",
  },
};

// ============================================================================
// USDC Token Addresses (per chain)
// ============================================================================

export const USDC_ADDRESSES: Record<number, string> = {
  1: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",     // Ethereum
  42161: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",   // Arbitrum (native)
  8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",    // Base
  10: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",      // Optimism
  137: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",     // Polygon
  56: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",      // BSC
  43114: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",   // Avalanche
};

// ============================================================================
// Platform Configuration
// ============================================================================

/** Platform fee applied to bridge and swap operations (0.1%) */
export const PLATFORM_FEE_PERCENT = 0.1;

/** Wallet that receives platform fees and credit purchases */
export const CREDITS_COLLECTION_WALLET =
  "0x87f1d896e39f0629c7a391d255364ed9C4a47Da0";

/** Chains supported by Circle CCTP (EVM chain IDs + Hypercore) */
export const CCTP_SUPPORTED_CHAINS = [1, 10, 137, 8453, 42161, 43114, 999];

/** Arbitrum USDC address (used for HL bridge operations) */
export const ARBITRUM_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

/** Arbitrum chain ID */
export const ARBITRUM_CHAIN_ID = 42161;
