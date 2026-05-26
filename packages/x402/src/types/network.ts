/**
 * X402 Network Configuration
 *
 * Unified network registry merging frontend display config with backend
 * contract addresses. Single source of truth for all chain-specific data.
 */

import { PaymentNetwork } from "./protocol";

// ============================================================================
// Network Config
// ============================================================================

/**
 * Configuration for a supported blockchain network.
 *
 * Each entry in {@link NETWORK_REGISTRY} conforms to this interface,
 * providing chain metadata, USDC contract details, and optional RPC/explorer URLs.
 */
export interface NetworkConfig {
  /** The EVM chain ID (e.g., 42161 for Arbitrum, 8453 for Base). */
  chainId: number;
  /** The USDC token contract address on this network. */
  usdcAddress: string;
  /** The EIP-712 token name used in the USDC contract domain separator. */
  usdcName: string;
  /** The EIP-712 token version used in the USDC contract domain separator. */
  usdcVersion: string;
  /** Optional public RPC endpoint URL for this network. */
  rpcUrl?: string;
  /** Human-readable network name for UI display. */
  displayName: string;
  /** Block explorer base URL (e.g., "https://basescan.org"). */
  explorerUrl?: string;
}

/**
 * Registry of all supported networks with their USDC contract addresses,
 * chain IDs, and EIP-712 domain info for signing.
 *
 * To add a new network, add an entry here — all downstream code (signing,
 * verification, middleware) picks it up automatically.
 */
export const NETWORK_REGISTRY: Record<string, NetworkConfig> = {
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
  [PaymentNetwork.AVALANCHE]: {
    chainId: 43114,
    usdcAddress: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    usdcName: "USD Coin",
    usdcVersion: "2",
    displayName: "Avalanche",
    explorerUrl: "https://snowtrace.io",
  },
  [PaymentNetwork.POLYGON]: {
    chainId: 137,
    usdcAddress: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    usdcName: "USD Coin",
    usdcVersion: "2",
    displayName: "Polygon",
    explorerUrl: "https://polygonscan.com",
  },
  [PaymentNetwork.OPTIMISM]: {
    chainId: 10,
    usdcAddress: "0x7F5c764cBc14f9669B88837ca1490cCa17c31607",
    usdcName: "USD Coin",
    usdcVersion: "2",
    displayName: "Optimism",
    explorerUrl: "https://optimistic.etherscan.io",
  },
};

// ============================================================================
// Helpers
// ============================================================================

/**
 * Get all supported network names.
 *
 * @returns An array of network name strings (e.g., `["arbitrum", "base", ...]`).
 *
 * @example
 * ```typescript
 * const networks = getSupportedNetworks();
 * // ["arbitrum", "base", "base-sepolia", "ethereum", "avalanche", "polygon", "optimism"]
 * ```
 */
export const getSupportedNetworks = (): string[] =>
  Object.keys(NETWORK_REGISTRY);

/**
 * Look up a network configuration by name (case-insensitive).
 *
 * Normalizes the input by lowercasing and replacing underscores with hyphens
 * before matching against the registry.
 *
 * @param network - The network name to look up (e.g., "base", "Base", "base_sepolia").
 * @returns The {@link NetworkConfig} if found, or `null` if the network is not supported.
 *
 * @example
 * ```typescript
 * const config = getNetworkConfig("base");
 * // { chainId: 8453, usdcAddress: "0x833...", ... }
 *
 * const missing = getNetworkConfig("solana");
 * // null
 * ```
 */
export const getNetworkConfig = (
  network: string,
): NetworkConfig | null => {
  const key = network.toLowerCase().replace("_", "-");
  return NETWORK_REGISTRY[key] ?? null;
};

/**
 * Get the EVM chain ID for a network name.
 *
 * @param network - The network name (e.g., "base", "arbitrum").
 * @returns The numeric chain ID, or `null` if the network is not supported.
 *
 * @example
 * ```typescript
 * getChainId("base");      // 8453
 * getChainId("unknown");   // null
 * ```
 */
export const getChainId = (network: string): number | null =>
  getNetworkConfig(network)?.chainId ?? null;

/**
 * Get the USDC contract address for a network.
 *
 * @param network - The network name (e.g., "base", "arbitrum").
 * @returns The checksummed USDC contract address, or `null` if the network is not supported.
 *
 * @example
 * ```typescript
 * getUSDCAddress("base");
 * // "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
 * ```
 */
export const getUSDCAddress = (network: string): string | null =>
  getNetworkConfig(network)?.usdcAddress ?? null;

/**
 * Look up a network configuration by its EVM chain ID.
 *
 * @param chainId - The EVM chain ID to search for (e.g., 8453).
 * @returns The {@link NetworkConfig} augmented with a `network` name string, or `null` if no match.
 *
 * @example
 * ```typescript
 * const result = getNetworkByChainId(8453);
 * // { chainId: 8453, network: "base", usdcAddress: "0x833...", ... }
 *
 * getNetworkByChainId(999999); // null
 * ```
 */
export const getNetworkByChainId = (
  chainId: number,
): (NetworkConfig & { network: string }) | null => {
  for (const [network, config] of Object.entries(NETWORK_REGISTRY)) {
    if (config.chainId === chainId) {
      return { ...config, network };
    }
  }
  return null;
};

/**
 * Check whether a network name is supported by the X402 registry.
 *
 * @param network - The network name to check (case-insensitive).
 * @returns `true` if the network is in the registry, `false` otherwise.
 *
 * @example
 * ```typescript
 * isNetworkSupported("base");    // true
 * isNetworkSupported("solana");  // false
 * ```
 */
export const isNetworkSupported = (network: string): boolean =>
  getNetworkConfig(network) !== null;

/**
 * Parse a network string into a {@link PaymentNetwork} enum value.
 *
 * Normalizes the input by lowercasing and replacing underscores with hyphens.
 * Recognizes aliases such as `"mainnet"` for {@link PaymentNetwork.ETHEREUM}.
 *
 * @param network - The network name string to parse.
 * @returns The matching {@link PaymentNetwork} enum value, or `null` if not recognized.
 *
 * @example
 * ```typescript
 * parseNetwork("base");       // PaymentNetwork.BASE
 * parseNetwork("mainnet");    // PaymentNetwork.ETHEREUM
 * parseNetwork("unknown");    // null
 * ```
 */
export const parseNetwork = (network: string): PaymentNetwork | null => {
  const normalized = network.toLowerCase().replace("_", "-");
  const map: Record<string, PaymentNetwork> = {
    arbitrum: PaymentNetwork.ARBITRUM,
    base: PaymentNetwork.BASE,
    "base-sepolia": PaymentNetwork.BASE_SEPOLIA,
    ethereum: PaymentNetwork.ETHEREUM,
    mainnet: PaymentNetwork.ETHEREUM,
    avalanche: PaymentNetwork.AVALANCHE,
    polygon: PaymentNetwork.POLYGON,
    optimism: PaymentNetwork.OPTIMISM,
  };
  return map[normalized] ?? null;
};

/**
 * Get the EVM chain ID for a network name, throwing if unsupported.
 *
 * Use this in contexts where an unsupported network is a programming error
 * (e.g., inside a payment flow where the network was already validated).
 *
 * @param network - The network name (e.g., "base", "arbitrum").
 * @returns The numeric chain ID.
 * @throws {Error} If the network is not in the X402 registry.
 *
 * @example
 * ```typescript
 * getChainIdOrThrow("base");     // 8453
 * getChainIdOrThrow("unknown");  // throws Error("Unsupported X402 network: unknown")
 * ```
 */
export const getChainIdOrThrow = (network: string): number => {
  const chainId = getChainId(network);
  if (chainId === null) {
    throw new Error(`Unsupported X402 network: ${network}`);
  }
  return chainId;
};
