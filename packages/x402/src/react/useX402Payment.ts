"use client";

/**
 * X402 React Hook — Wagmi Adapter
 *
 * Thin React hook wrapping the framework-agnostic X402 client.
 * Uses wagmi for wallet connection and viem for on-chain reads.
 *
 * For agent wallet signing or custom wallet providers, use the
 * `@cod3x/x402/client` module directly instead of this hook.
 */

import { useCallback, useState } from "react";
import type { Address } from "viem";
import {
  useAccount,
  usePublicClient,
  useSwitchChain,
  useWalletClient,
} from "wagmi";

import {
  signTransferAuthorization,
  generateNonce,
  createValidityWindow,
  type X402Signer,
} from "../client/signing";
import { createPaymentPayload } from "../client/payload";
import { ViemBalanceChecker, type BalanceChecker } from "../client/balance";
import { encodePaymentHeader } from "../types/utils";
import { getNetworkConfig, getChainIdOrThrow } from "../types/network";
import { X402Error, X402ErrorCode } from "../types/errors";
import type {
  X402PaymentRequirements,
  X402PaymentStatus,
  SignedAuthorizationWithSig,
} from "../types/protocol";

// ============================================================================
// Types
// ============================================================================

/**
 * Return type of the {@link useX402Payment} hook.
 *
 * Provides methods for handling X402 payments and reactive state for UI rendering.
 */
export interface UseX402PaymentReturn {
  /**
   * Sign a payment for the given requirements and return the base64 `X-Payment` header value.
   *
   * Handles network switching, balance checking, and EIP-3009 signing automatically.
   *
   * @param requirements - The 402 response body containing accepted payment options.
   * @returns The base64-encoded payment header string.
   * @throws {X402Error} On wallet issues, insufficient balance, or signing failures.
   */
  handlePaymentRequired: (
    requirements: X402PaymentRequirements,
  ) => Promise<string>;
  /**
   * Make a fetch request that may return HTTP 402.
   *
   * Automatically handles the payment flow: if the server returns 402, signs a payment
   * and retries the request with the `X-Payment` header.
   *
   * @param url - The URL to fetch.
   * @param options - Standard fetch `RequestInit` options.
   * @returns The parsed JSON response body.
   * @throws {X402Error} On payment failures.
   */
  makePaymentRequest: <T>(url: string, options?: RequestInit) => Promise<T>;
  /**
   * Check the connected wallet's USDC balance against a required amount.
   *
   * @param amount - Required amount in atomic units.
   * @param tokenAddress - The USDC contract address.
   * @param walletAddress - Optional override wallet address.
   * @param chainId - Optional override chain ID.
   * @returns An object with `hasBalance` and the actual `balance`.
   */
  checkUSDCBalance: (
    amount: bigint,
    tokenAddress: Address,
    walletAddress?: Address,
    chainId?: number,
  ) => Promise<{ hasBalance: boolean; balance: bigint }>;
  /** The current payment requirements (set when a 402 response is received). */
  paymentRequirements: X402PaymentRequirements | null;
  /** The current step of the payment flow. */
  paymentStatus: X402PaymentStatus;
  /** Whether a payment is currently being processed. */
  isProcessing: boolean;
  /** The most recent error message, or `null` if no error. */
  error: string | null;
  /** Whether a wallet is currently connected. */
  isConnected: boolean;
  /** Reset all payment state back to initial values. */
  resetPayment: () => void;
}

// ============================================================================
// Hook
// ============================================================================

/**
 * React hook for X402 payments using a wagmi-connected wallet.
 *
 * Provides reactive payment state and methods for:
 * - Handling HTTP 402 responses with automatic signing
 * - Making payment-aware fetch requests
 * - Checking USDC balances
 *
 * Requires wagmi's `WagmiProvider` in the component tree.
 *
 * @returns A {@link UseX402PaymentReturn} object with payment methods and state.
 *
 * @example
 * ```typescript
 * function PremiumContent() {
 *   const { makePaymentRequest, paymentStatus, error } = useX402Payment();
 *
 *   const fetchContent = async () => {
 *     const data = await makePaymentRequest<{ content: string }>("/api/premium");
 *     console.log(data.content);
 *   };
 *
 *   return <button onClick={fetchContent}>Get Premium Content</button>;
 * }
 * ```
 */
export const useX402Payment = (): UseX402PaymentReturn => {
  const { address, chain } = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();
  const { switchChainAsync } = useSwitchChain();

  const [isProcessing, setIsProcessing] = useState(false);
  const [paymentRequirements, setPaymentRequirements] =
    useState<X402PaymentRequirements | null>(null);
  const [paymentStatus, setPaymentStatus] = useState<X402PaymentStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const resetPayment = useCallback(() => {
    setPaymentStatus("idle");
    setError(null);
    setPaymentRequirements(null);
    setIsProcessing(false);
  }, []);

  /**
   * Check USDC balance using the connected wallet's public client.
   */
  const checkUSDCBalance = useCallback(
    async (
      amount: bigint,
      tokenAddress: Address,
      walletAddress?: Address,
      chainId?: number,
    ): Promise<{ hasBalance: boolean; balance: bigint }> => {
      const addressToCheck = walletAddress || address;
      if (!addressToCheck || !publicClient) {
        return { hasBalance: false, balance: BigInt(0) };
      }

      const checker: BalanceChecker = new ViemBalanceChecker(publicClient);
      return checker.checkBalance({
        tokenAddress,
        walletAddress: addressToCheck,
        chainId: chainId ?? chain?.id ?? 0,
        requiredAmount: amount,
      });
    },
    [address, publicClient, chain],
  );

  /**
   * Create a wagmi-backed X402Signer from the current wallet client.
   */
  const createWagmiSigner = useCallback((): X402Signer => {
    if (!walletClient || !address) {
      throw new X402Error(
        X402ErrorCode.WALLET_CLIENT_NOT_READY,
        "Wallet client not ready",
      );
    }

    return {
      address,
      signTypedData: async (params) => {
        const signature = await walletClient.signTypedData({
          account: address as Address,
          domain: params.domain as any,
          types: params.types as any,
          primaryType: params.primaryType as any,
          message: params.message,
        });
        return signature;
      },
    };
  }, [walletClient, address]);

  /**
   * Handle a 402 response: switch networks, check balance, sign payment.
   */
  const handlePaymentRequired = useCallback(
    async (requirements: X402PaymentRequirements): Promise<string> => {
      if (!address) {
        throw new X402Error(
          X402ErrorCode.WALLET_NOT_CONNECTED,
          "Wallet not connected",
        );
      }

      if (!requirements.accepts?.length) {
        throw new X402Error(
          X402ErrorCode.INVALID_REQUIREMENTS,
          "No payment options available",
        );
      }

      setPaymentRequirements(requirements);
      setError(null);
      setIsProcessing(true);

      try {
        const paymentOption = requirements.accepts[0];
        const amountInAtomicUnits = BigInt(paymentOption.maxAmountRequired);
        const expectedChainId = getChainIdOrThrow(paymentOption.network);

        // Switch network if needed
        let chainId = chain?.id ?? expectedChainId;
        if (chain?.id !== expectedChainId) {
          setPaymentStatus("connecting");
          try {
            await switchChainAsync({
              chainId: expectedChainId as any,
            });
            chainId = expectedChainId;
          } catch (switchError) {
            throw new X402Error(
              X402ErrorCode.NETWORK_SWITCH_FAILED,
              `Please switch to ${paymentOption.network} network`,
            );
          }
        }

        // Check balance
        setPaymentStatus("checking_balance");
        const { hasBalance, balance } = await checkUSDCBalance(
          amountInAtomicUnits,
          paymentOption.asset as Address,
          address,
          chainId,
        );

        if (!hasBalance) {
          const requiredUsdc = Number(amountInAtomicUnits) / 1_000_000;
          const availableUsdc = Number(balance) / 1_000_000;
          throw new X402Error(
            X402ErrorCode.INSUFFICIENT_BALANCE,
            `Insufficient USDC balance. Required: $${requiredUsdc.toFixed(2)}, Available: $${availableUsdc.toFixed(2)}`,
          );
        }

        // Sign the authorization
        setPaymentStatus("signing");
        const signer = createWagmiSigner();
        const nonce = generateNonce();
        const { validAfter, validBefore } = createValidityWindow();
        const tokenName = paymentOption.extra?.name || "USD Coin";
        const tokenVersion = paymentOption.extra?.version || "2";

        const signedAuth = await signTransferAuthorization(signer, {
          from: address,
          to: paymentOption.payTo,
          value: amountInAtomicUnits,
          validAfter,
          validBefore,
          nonce,
          usdcAddress: paymentOption.asset,
          tokenName,
          tokenVersion,
          chainId,
        });

        // Create and encode payment payload
        setPaymentStatus("verifying");
        const payload = createPaymentPayload(signedAuth, paymentOption.network);
        const paymentHeader = encodePaymentHeader(payload);

        setPaymentStatus("success");
        setIsProcessing(false);
        return paymentHeader;
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "Failed to process payment";
        setError(errorMessage);
        setPaymentStatus("error");
        setIsProcessing(false);
        throw err;
      }
    },
    [
      address,
      chain,
      switchChainAsync,
      checkUSDCBalance,
      createWagmiSigner,
    ],
  );

  /**
   * Make a request that may require payment. Automatically handles 402 responses.
   */
  const makePaymentRequest = useCallback(
    async <T>(url: string, options?: RequestInit): Promise<T> => {
      setError(null);

      try {
        const initialResponse = await fetch(url, {
          ...options,
          headers: {
            ...options?.headers,
            "Content-Type": "application/json",
          },
        });

        if (initialResponse.status === 402) {
          const requirements: X402PaymentRequirements =
            await initialResponse.json();
          const paymentHeader = await handlePaymentRequired(requirements);

          const paidResponse = await fetch(url, {
            ...options,
            headers: {
              ...options?.headers,
              "Content-Type": "application/json",
              "X-Payment": paymentHeader,
            },
          });

          if (!paidResponse.ok) {
            const errorData = await paidResponse.json();
            throw new X402Error(
              X402ErrorCode.PAYMENT_VERIFICATION_FAILED,
              errorData.message || "Payment verification failed",
            );
          }

          return await paidResponse.json();
        }

        if (!initialResponse.ok) {
          throw new Error(`Request failed: ${initialResponse.statusText}`);
        }

        return await initialResponse.json();
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "Request failed";
        setError(errorMessage);
        throw err;
      }
    },
    [handlePaymentRequired],
  );

  return {
    handlePaymentRequired,
    makePaymentRequest,
    checkUSDCBalance,
    paymentRequirements,
    paymentStatus,
    isProcessing,
    error,
    isConnected: !!address,
    resetPayment,
  };
};
