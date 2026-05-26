"use client";

/**
 * useFundingStrategy
 *
 * Determines the best way to fund an agent wallet. ALL funding flows are
 * ETH-only — the backend then handles converting ETH → USDC and depositing
 * to Hyperliquid via the agent's queue worker.
 *
 * Returns one of four paths:
 *  • "connect-wallet"  — wallet user with enough ETH on Arbitrum → connect
 *                        wagmi + sign a single transfer
 *  • "external-wallet" — manual: show the agent address, user sends ETH from
 *                        any external source (Coinbase, hardware wallet, etc.)
 *  • "onramper"        — fiat onramp: pay with a card, ETH lands directly in
 *                        the agent wallet on Arbitrum
 *  • "bridge-pending"  — new-user-only: user has ≥ amount worth of funds on
 *                        some other chain per DeBank, but nothing on Arbitrum.
 *                        UI should offer OnRamper AND a "I'll bridge it myself"
 *                        button that polls Arbitrum and auto-advances.
 *
 * New-user multichain scan:
 *   For users with 0 existing agents we make one DeBank call (server-cached)
 *   to detect off-chain funds. Returning users skip this — they already know
 *   how the flow works and we don't want to burn DeBank credits on them.
 *
 * Wallet detection signal: a user signed in via wallet auth has an email of
 * the form `<address>@usemoon.ai` in Supabase. We extract the address from
 * the email — the wallet does NOT need to be currently connected via wagmi
 * for us to scan its balance (we use a public RPC for read-only queries).
 *
 * To actually transact via "connect-wallet", the user will still need to
 * connect via wagmi to sign.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { createPublicClient, formatUnits, http, isAddress } from "viem";
import { arbitrum } from "viem/chains";
import { dataGetUserDebankTotalBalance } from "@repo/api-client/data";
import { useAuth } from "@/hooks/use-auth";
import { useBotConfigs } from "@/hooks/bots/useBotConfigs";
import { useEthPrice } from "@/hooks/funding/useEthPrice";

// ── Constants ──

const ETH_DECIMALS = 18;

// Fallback only used during the brief window while useEthPrice loads
const ETH_USD_FALLBACK = 3000;

// DeBank's chain ID for Arbitrum in the `chain_list` array.
const DEBANK_ARBITRUM_ID = "arb";

// ── Types ──

export type FundingPath =
  | "connect-wallet"
  | "external-wallet"
  | "onramper"
  | "bridge-pending";

export interface OtherChainBalance {
  /** DeBank chain id (e.g. "eth", "base", "matic") */
  id: string;
  /** Human-readable chain name (e.g. "Ethereum", "Base") */
  name: string;
  /** USD value on that chain */
  usdValue: number;
}

export interface FundingStrategy {
  /** Recommended funding path. `null` while loading. */
  path: FundingPath | null;
  /** True if the user signed in with a wallet (`<addr>@usemoon.ai` email). */
  isWalletUser: boolean;
  /** The user's wallet address (extracted from email if wallet user). */
  userWalletAddress: string | null;
  /** ETH balance on Arbitrum (formatted, e.g. "0.0345"). Empty if not loaded. */
  ethBalance: string;
  /** ETH balance converted to approximate USD value. */
  ethBalanceUsd: number;
  /** Whether the user has enough ETH on Arbitrum to cover the requested amount. */
  hasEnoughBalance: boolean;
  /** Loading state for the balance scan. */
  isScanning: boolean;
  /** Reason explaining why this path was chosen — useful for UI hints. */
  reason: string;
  /**
   * Other chains where the user has ≥ requested amount in funds.
   * Populated only for new users (one-time DeBank scan). Empty otherwise.
   */
  otherChainBalances: OtherChainBalance[];
  /** Sum of usdValue across otherChainBalances. */
  otherChainsUsdValue: number;
}

// ── Helpers ──

/**
 * Extract a wallet address from a Supabase email of the form
 * `<address>@usemoon.ai`. Returns null if the email doesn't match.
 */
export function extractWalletFromEmail(email: string | undefined | null): string | null {
  if (!email) return null;
  const match = email.match(/^(0x[a-fA-F0-9]{40})@usemoon\.ai$/i);
  if (!match) return null;
  return match[1];
}

/**
 * Public Arbitrum client for read-only balance queries. No wallet connection
 * required.
 */
function getArbitrumClient() {
  return createPublicClient({
    chain: arbitrum,
    transport: http(),
  });
}

// ── Hook ──

export interface UseFundingStrategyOptions {
  /** Target fund amount in USD. Used to compare against current balances. */
  amountUsd: number;
  /** Override the user wallet address (e.g. for testing). */
  overrideWallet?: string;
  /** Disable scanning if false. */
  enabled?: boolean;
}

export function useFundingStrategy({
  amountUsd,
  overrideWallet,
  enabled = true,
}: UseFundingStrategyOptions): FundingStrategy {
  const { session } = useAuth();
  const { ethPrice } = useEthPrice();
  const userEmail = session?.user?.email;

  // 1. Detect auth type from email
  const userWalletAddress = useMemo(
    () => overrideWallet ?? extractWalletFromEmail(userEmail),
    [userEmail, overrideWallet],
  );
  const isWalletUser = userWalletAddress !== null;

  // 2. Determine if this is a new user. We use `<= 1` because by the time the
  // FundingFlow mounts inside the creation wizard, the user's first agent has
  // already been created (bot_config row exists). So "bots.length === 0" would
  // miss the primary use case. Server cache dedupes the DeBank call so the
  // occasional 2nd-agent scan is cheap.
  const { bots, isLoading: botsLoading } = useBotConfigs();
  const isNewUser = !botsLoading && bots.length <= 1;

  // 3. Scan ETH balance on Arbitrum if wallet user
  const [isScanning, setIsScanning] = useState(false);
  const [ethBalanceWei, setEthBalanceWei] = useState<bigint | null>(null);

  useEffect(() => {
    if (!enabled || !isWalletUser || !userWalletAddress || !isAddress(userWalletAddress)) {
      return;
    }

    let cancelled = false;
    setIsScanning(true);

    const client = getArbitrumClient();
    client
      .getBalance({ address: userWalletAddress as `0x${string}` })
      .then((eth) => {
        if (cancelled) return;
        setEthBalanceWei(eth);
      })
      .catch(() => {
        if (cancelled) return;
        setEthBalanceWei(BigInt(0));
      })
      .finally(() => {
        if (!cancelled) setIsScanning(false);
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, isWalletUser, userWalletAddress]);

  // 4. New-user multichain scan via DeBank (server-cached, 60 min TTL). Only
  // fires for wallet users with 0 existing agents. The query key includes the
  // address so it's cached per-wallet on the client too.
  const multichainQuery = useQuery({
    queryKey: ["funding-debank-total-balance", userWalletAddress],
    queryFn: async () => {
      if (!userWalletAddress) return null;
      const res = await dataGetUserDebankTotalBalance(userWalletAddress, {
        cacheMaxAge: 60, // 60 min server cache — don't burn DeBank credits
      });
      return res.data as { total_usd_value: number; chain_list: Array<{ id: string; name: string; usd_value: number }> } | null;
    },
    enabled:
      enabled &&
      isWalletUser &&
      isNewUser &&
      !!userWalletAddress &&
      isAddress(userWalletAddress),
    staleTime: 60 * 60 * 1000, // match server TTL
    retry: 1,
  });

  const otherChainBalances = useMemo<OtherChainBalance[]>(() => {
    const data = multichainQuery.data;
    if (!data?.chain_list) return [];
    return data.chain_list
      .filter((c) => c.id !== DEBANK_ARBITRUM_ID && c.usd_value >= amountUsd)
      .map((c) => ({ id: c.id, name: c.name, usdValue: c.usd_value }))
      .sort((a, b) => b.usdValue - a.usdValue);
  }, [multichainQuery.data, amountUsd]);

  const otherChainsUsdValue = useMemo(
    () => otherChainBalances.reduce((sum, c) => sum + c.usdValue, 0),
    [otherChainBalances],
  );

  // 5. Format Arbitrum balance
  const ethBalance = ethBalanceWei != null ? formatUnits(ethBalanceWei, ETH_DECIMALS) : "";
  const ethBalanceUsd = parseFloat(ethBalance || "0") * ethPrice;

  // 6. Decide path
  const { path, reason, hasEnoughBalance } = useMemo(() => {
    // Email/Google user → onramper is the simplest default
    if (!isWalletUser) {
      return {
        path: "onramper" as FundingPath,
        reason: "You signed in with email — pay with a card by default.",
        hasEnoughBalance: false,
      };
    }

    // Still loading (Arbitrum check, or new-user multichain scan in flight)
    const multichainLoading =
      isNewUser && multichainQuery.isLoading && !multichainQuery.data;
    if (isScanning || ethBalanceWei == null || botsLoading || multichainLoading) {
      return {
        path: null,
        reason: "Checking your wallet balance...",
        hasEnoughBalance: false,
      };
    }

    // Wallet user with enough ETH on Arbitrum → connect wallet and sign
    if (ethBalanceUsd >= amountUsd) {
      return {
        path: "connect-wallet" as FundingPath,
        reason: `You have ~$${ethBalanceUsd.toFixed(0)} of ETH on Arbitrum — connect your wallet to send it.`,
        hasEnoughBalance: true,
      };
    }

    // New user, empty on Arbitrum, but has funds on other chains → bridge-pending
    if (otherChainBalances.length > 0) {
      const topChain = otherChainBalances[0];
      return {
        path: "bridge-pending" as FundingPath,
        reason: `You have ~$${otherChainsUsdValue.toFixed(0)} on ${topChain.name}${otherChainBalances.length > 1 ? ` (+${otherChainBalances.length - 1} more)` : ""}. Bridge to Arbitrum or pay with a card.`,
        hasEnoughBalance: false,
      };
    }

    // Wallet user but truly empty → onramper as default fallback
    return {
      path: "onramper" as FundingPath,
      reason: "Your wallet doesn't have enough ETH — pay with a card by default.",
      hasEnoughBalance: false,
    };
  }, [
    isWalletUser,
    isScanning,
    ethBalanceWei,
    ethBalanceUsd,
    amountUsd,
    botsLoading,
    isNewUser,
    multichainQuery.isLoading,
    multichainQuery.data,
    otherChainBalances,
    otherChainsUsdValue,
  ]);

  return {
    path,
    isWalletUser,
    userWalletAddress,
    ethBalance,
    ethBalanceUsd,
    hasEnoughBalance,
    isScanning,
    reason,
    otherChainBalances,
    otherChainsUsdValue,
  };
}
