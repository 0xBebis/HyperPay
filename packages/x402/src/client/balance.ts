/**
 * X402 Client — Balance Checking
 *
 * Abstract interface for checking ERC20 token balances.
 * The default implementation uses viem's readContract.
 */

// ============================================================================
// Interface
// ============================================================================

/**
 * Abstract balance checker. Implement this to use any RPC provider
 * or API for balance checks (viem, ethers, Alchemy, Infura, etc.)
 */
export interface BalanceChecker {
  /**
   * Check whether a wallet has sufficient ERC20 token balance.
   *
   * @param params - Balance check parameters.
   * @param params.tokenAddress - The ERC20 token contract address (e.g., USDC).
   * @param params.walletAddress - The wallet address to check.
   * @param params.chainId - The EVM chain ID for the check.
   * @param params.requiredAmount - The minimum required balance in atomic units.
   * @returns An object with `hasBalance` (whether balance >= required) and the actual `balance`.
   */
  checkBalance(params: {
    tokenAddress: string;
    walletAddress: string;
    chainId: number;
    requiredAmount: bigint;
  }): Promise<{ hasBalance: boolean; balance: bigint }>;
}

// ============================================================================
// ERC20 ABI (minimal — balanceOf only)
// ============================================================================

/** Minimal ERC20 ABI containing only the `balanceOf` function, used for on-chain balance reads. */
export const ERC20_BALANCE_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// ============================================================================
// Default Implementation (viem)
// ============================================================================

/**
 * Default balance checker using a viem PublicClient.
 *
 * Usage:
 * ```typescript
 * import { createPublicClient, http } from "viem";
 * import { base } from "viem/chains";
 *
 * const client = createPublicClient({ chain: base, transport: http() });
 * const checker = new ViemBalanceChecker(client);
 * const { hasBalance, balance } = await checker.checkBalance({
 *   tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
 *   walletAddress: "0x...",
 *   chainId: 8453,
 *   requiredAmount: 25_000_000n, // 25 USDC
 * });
 * ```
 */
export class ViemBalanceChecker implements BalanceChecker {
  private client: {
    readContract(args: {
      address: string;
      abi: typeof ERC20_BALANCE_ABI;
      functionName: "balanceOf";
      args: [string];
    }): Promise<bigint>;
  };

  /**
   * Create a new ViemBalanceChecker.
   *
   * @param publicClient - A viem `PublicClient` (or any object implementing `readContract`).
   */
  constructor(publicClient: {
    readContract(args: {
      address: string;
      abi: readonly unknown[];
      functionName: string;
      args: readonly unknown[];
    }): Promise<unknown>;
  }) {
    this.client = publicClient as typeof this.client;
  }

  /**
   * Check whether a wallet has sufficient ERC20 token balance using viem's `readContract`.
   *
   * @param params - Balance check parameters.
   * @param params.tokenAddress - The ERC20 token contract address.
   * @param params.walletAddress - The wallet address to query.
   * @param params.chainId - The EVM chain ID (used for context, not routing).
   * @param params.requiredAmount - The minimum required balance in atomic units.
   * @returns An object with `hasBalance` and the actual `balance`. On error, returns `{ hasBalance: false, balance: 0n }`.
   */
  async checkBalance(params: {
    tokenAddress: string;
    walletAddress: string;
    chainId: number;
    requiredAmount: bigint;
  }): Promise<{ hasBalance: boolean; balance: bigint }> {
    try {
      const balance = (await this.client.readContract({
        address: params.tokenAddress,
        abi: ERC20_BALANCE_ABI,
        functionName: "balanceOf",
        args: [params.walletAddress],
      })) as bigint;

      return {
        hasBalance: balance >= params.requiredAmount,
        balance,
      };
    } catch (err) {
      console.error("Error checking ERC20 balance:", err);
      return { hasBalance: false, balance: BigInt(0) };
    }
  }
}
