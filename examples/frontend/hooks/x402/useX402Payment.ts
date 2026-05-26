"use client";

/**
 * X402 Payment Hook
 * Handles EIP-3009 gasless USDC payments for premium content
 */

import { useCallback, useState } from "react";
import type { Address, Hex } from "viem";
import { arbitrum, base, baseSepolia, mainnet } from "viem/chains";
import {
  useAccount,
  usePublicClient,
  useSwitchChain,
  useWalletClient,
} from "wagmi";
import { useAuth } from "@/hooks/use-auth";
import {
  encodePaymentHeader,
  getChainIdFromNetwork,
  type SignedAuthorizationWithSig,
  type TransferAuthorization,
  X402Error,
  X402ErrorCode,
  type X402PaymentPayload,
  type X402PaymentRequirements,
  type X402PaymentStatus,
} from "@/types/x402";

// ============================================================================
// Constants
// ============================================================================

const USDC_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const getEIP712Domain = (
  chainId: number,
  verifyingContract: Address,
  name: string,
  version: string
) => ({
  name,
  version,
  chainId,
  verifyingContract,
});

const _getChainFromId = (chainId: number) => {
  switch (chainId) {
    case 42161:
      return arbitrum;
    case 8453:
      return base;
    case 84532:
      return baseSepolia;
    case 1:
      return mainnet;
    default:
      return null;
  }
};

// ============================================================================
// Types
// ============================================================================

interface AgentWalletInfo {
  accountName: string;
  address: Address;
}

interface UseX402PaymentReturn {
  handlePaymentRequired: (
    requirements: X402PaymentRequirements,
    agentWallet?: AgentWalletInfo
  ) => Promise<string>;
  makePaymentRequest: <T>(url: string, options?: RequestInit) => Promise<T>;
  checkExistingPayment: (resourceId: string) => Promise<boolean>;
  checkUSDCBalance: (
    amount: bigint,
    tokenAddress: Address,
    walletAddress?: Address,
    chainId?: number,
    agentAccountName?: string
  ) => Promise<{ hasBalance: boolean; balance: bigint }>;
  paymentRequirements: X402PaymentRequirements | null;
  paymentStatus: X402PaymentStatus;
  isProcessing: boolean;
  error: string | null;
  isConnected: boolean;
  resetPayment: () => void;
}

// ============================================================================
// Hook
// ============================================================================

export const useX402Payment = (): UseX402PaymentReturn => {
  const { address, chain } = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();
  const { switchChainAsync } = useSwitchChain();
  const { session } = useAuth();

  const [isProcessing, setIsProcessing] = useState(false);
  const [paymentRequirements, setPaymentRequirements] =
    useState<X402PaymentRequirements | null>(null);
  const [paymentStatus, setPaymentStatus] = useState<X402PaymentStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  /**
   * Reset payment state
   */
  const resetPayment = useCallback(() => {
    setPaymentStatus("idle");
    setError(null);
    setPaymentRequirements(null);
    setIsProcessing(false);
  }, []);

  /**
   * Generate a random nonce for the payment
   */
  const generateNonce = useCallback((): Hex => {
    const randomBytes = new Uint8Array(32);
    crypto.getRandomValues(randomBytes);
    return `0x${Array.from(randomBytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")}` as Hex;
  }, []);

  /**
   * Check USDC balance for agent wallet via Moon SDK API
   */
  const checkAgentWalletBalance = useCallback(
    async (
      accountName: string,
      tokenAddress: Address,
      chainId: number
    ): Promise<bigint> => {
      const authToken = session?.access_token;

      if (!authToken) {
        console.warn("No auth token for agent wallet balance check");
        return BigInt(0);
      }

      try {
        const baseUrl =
          process.env.NEXT_PUBLIC_API_URL || "https://api.usemoon.ai";
        const response = await fetch(
          `${baseUrl}/erc20/${accountName}/balanceOf?chainId=${chainId}&address=${tokenAddress}`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${authToken}`,
            },
          }
        );

        if (!response.ok) {
          console.error("Agent balance check failed:", response.status);
          return BigInt(0);
        }

        const result = await response.json();
        // API returns { success: true, data: "balance_string" }
        const balanceStr = result?.data || result?.balance || "0";
        return BigInt(balanceStr);
      } catch (err) {
        console.error("Error checking agent wallet balance:", err);
        return BigInt(0);
      }
    },
    [session?.access_token]
  );

  /**
   * Check USDC balance
   */
  const checkUSDCBalance = useCallback(
    async (
      amount: bigint,
      tokenAddress: Address,
      walletAddress?: Address,
      chainId?: number,
      agentAccountName?: string
    ): Promise<{ hasBalance: boolean; balance: bigint }> => {
      // For agent wallets, use Moon SDK API
      if (agentAccountName && chainId) {
        const balance = await checkAgentWalletBalance(
          agentAccountName,
          tokenAddress,
          chainId
        );
        return {
          hasBalance: balance >= amount,
          balance,
        };
      }

      // For user wallets, use publicClient
      const addressToCheck = walletAddress || address;

      if (!addressToCheck) {
        return { hasBalance: false, balance: BigInt(0) };
      }

      try {
        if (!publicClient) {
          return { hasBalance: false, balance: BigInt(0) };
        }

        const balance = (await publicClient.readContract({
          address: tokenAddress,
          abi: USDC_ABI,
          functionName: "balanceOf",
          args: [addressToCheck],
        })) as bigint;

        return {
          hasBalance: balance >= amount,
          balance,
        };
      } catch (err) {
        console.error("Error checking USDC balance:", err);
        return { hasBalance: false, balance: BigInt(0) };
      }
    },
    [address, publicClient, checkAgentWalletBalance]
  );

  /**
   * Create and sign an EIP-3009 Transfer Authorization
   */
  const signTransferAuthorization = useCallback(
    async (
      from: Address,
      to: Address,
      value: bigint,
      validAfter: bigint,
      validBefore: bigint,
      nonce: Hex,
      usdcAddress: Address,
      tokenName: string,
      tokenVersion: string,
      chainId: number
    ): Promise<SignedAuthorizationWithSig> => {
      if (!walletClient) {
        throw new X402Error(
          X402ErrorCode.WALLET_CLIENT_NOT_READY,
          "Wallet client not ready"
        );
      }

      const domain = getEIP712Domain(
        chainId,
        usdcAddress,
        tokenName,
        tokenVersion
      );

      const message = {
        from,
        to,
        value,
        validAfter,
        validBefore,
        nonce,
      };

      try {
        const signature = await walletClient.signTypedData({
          account: from,
          domain,
          types: TRANSFER_WITH_AUTHORIZATION_TYPES,
          primaryType: "TransferWithAuthorization",
          message,
        });

        // Parse the signature into v, r, s components
        const r = signature.slice(0, 66) as Hex;
        const s = `0x${signature.slice(66, 130)}` as Hex;
        const v = parseInt(signature.slice(130, 132), 16);

        return {
          from,
          to,
          value,
          validAfter,
          validBefore,
          nonce,
          v,
          r,
          s,
        };
      } catch (err) {
        console.error("Error signing authorization:", err);
        throw new X402Error(
          X402ErrorCode.INVALID_SIGNATURE,
          "Failed to sign payment authorization"
        );
      }
    },
    [walletClient]
  );

  /**
   * Sign with agent wallet using Moon SDK
   */
  const signTransferAuthorizationWithAgent = useCallback(
    async (
      accountName: string,
      from: Address,
      to: Address,
      value: bigint,
      validAfter: bigint,
      validBefore: bigint,
      nonce: Hex,
      usdcAddress: Address,
      tokenName: string,
      tokenVersion: string,
      chainId: number
    ): Promise<SignedAuthorizationWithSig> => {
      const authToken = session?.access_token;

      if (!authToken) {
        throw new X402Error(
          X402ErrorCode.AGENT_SDK_ERROR,
          "No authentication token available"
        );
      }

      const domain = getEIP712Domain(
        chainId,
        usdcAddress,
        tokenName,
        tokenVersion
      );

      const message = {
        from,
        to,
        value: value.toString(),
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce,
      };

      const eip712Payload = {
        types: {
          EIP712Domain: [
            { name: "name", type: "string" },
            { name: "version", type: "string" },
            { name: "chainId", type: "uint256" },
            { name: "verifyingContract", type: "address" },
          ],
          ...TRANSFER_WITH_AUTHORIZATION_TYPES,
        },
        primaryType: "TransferWithAuthorization",
        domain,
        message,
      };

      try {
        const baseUrl =
          process.env.NEXT_PUBLIC_API_URL || "https://api.usemoon.ai";
        const response = await fetch(
          `${baseUrl}/accounts/${accountName}/sign-typed-data`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${authToken}`,
            },
            body: JSON.stringify({
              chain_id: chainId.toString(),
              data: JSON.stringify(eip712Payload),
            }),
          }
        );

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(
            errorData.message ||
              `HTTP ${response.status}: Failed to sign typed data`
          );
        }

        const result = await response.json();

        if (!result?.data?.signature) {
          throw new Error("Invalid signature response from API");
        }

        const signature = result.data.signature as Hex;

        if (!signature || signature.length !== 132) {
          throw new Error(
            `Invalid signature format. Expected 132 chars, got ${signature?.length}`
          );
        }

        const r = signature.slice(0, 66) as Hex;
        const s = `0x${signature.slice(66, 130)}` as Hex;
        const v = parseInt(signature.slice(130, 132), 16);

        return {
          from,
          to,
          value,
          validAfter,
          validBefore,
          nonce,
          v,
          r,
          s,
        };
      } catch (err) {
        console.error("Error signing authorization with agent:", err);
        const errorMessage =
          err instanceof Error ? err.message : "Unknown error occurred";
        throw new X402Error(
          X402ErrorCode.AGENT_SDK_ERROR,
          `Failed to sign with agent wallet: ${errorMessage}`
        );
      }
    },
    [session?.access_token]
  );

  /**
   * Create X402 payment payload from signed authorization
   */
  const createPaymentPayload = useCallback(
    (
      signedAuth: SignedAuthorizationWithSig,
      network: string
    ): X402PaymentPayload => {
      const authorization: TransferAuthorization = {
        from: signedAuth.from,
        to: signedAuth.to,
        value: signedAuth.value.toString(),
        validAfter: signedAuth.validAfter.toString(),
        validBefore: signedAuth.validBefore.toString(),
        nonce: signedAuth.nonce,
      };

      // Combine r + s + v into a single signature hex string
      const rWithout0x = signedAuth.r.slice(2);
      const sWithout0x = signedAuth.s.slice(2);
      const vHex = signedAuth.v.toString(16).padStart(2, "0");
      const fullSignature = `0x${rWithout0x}${sWithout0x}${vHex}` as Hex;

      return {
        x402Version: 1,
        scheme: "exact",
        network,
        payload: {
          signature: fullSignature,
          authorization,
        },
      };
    },
    []
  );

  /**
   * Process a 402 response and initiate payment
   */
  const handlePaymentRequired = useCallback(
    async (
      requirements: X402PaymentRequirements,
      agentWallet?: AgentWalletInfo
    ): Promise<string> => {
      const payerAddress = agentWallet?.address || address;

      if (!payerAddress) {
        throw new X402Error(
          X402ErrorCode.WALLET_NOT_CONNECTED,
          "Wallet not connected"
        );
      }

      if (!requirements.accepts || requirements.accepts.length === 0) {
        throw new X402Error(
          X402ErrorCode.INVALID_REQUIREMENTS,
          "No payment options available"
        );
      }

      setPaymentRequirements(requirements);
      setError(null);
      setIsProcessing(true);

      try {
        const paymentOption = requirements.accepts[0];
        const amountInAtomicUnits = BigInt(paymentOption.maxAmountRequired);
        const expectedChainId = getChainIdFromNetwork(paymentOption.network);

        // Handle network switching for user wallet
        let chainId = expectedChainId;
        if (!agentWallet) {
          if (!chain?.id) {
            throw new X402Error(
              X402ErrorCode.NETWORK_MISMATCH,
              "Unable to determine wallet network"
            );
          }

          chainId = chain.id;
          if (chain.id !== expectedChainId) {
            setPaymentStatus("connecting");
            try {
              // Cast to any to handle wagmi's strict chain ID typing
              await switchChainAsync({
                chainId: expectedChainId as Parameters<
                  typeof switchChainAsync
                >[0]["chainId"],
              });
              chainId = expectedChainId;
            } catch (switchError) {
              const errorMsg =
                switchError instanceof Error
                  ? switchError.message
                  : "Network switch failed";
              throw new X402Error(
                X402ErrorCode.NETWORK_SWITCH_FAILED,
                `Please switch to ${paymentOption.network} network. ${errorMsg}`
              );
            }
          }
        }

        // Check balance
        setPaymentStatus("checking_balance");
        const { hasBalance, balance } = await checkUSDCBalance(
          amountInAtomicUnits,
          paymentOption.asset as Address,
          payerAddress,
          chainId,
          agentWallet?.accountName // Pass agent account name for Moon SDK balance check
        );

        if (!hasBalance) {
          const requiredUsdc = Number(amountInAtomicUnits) / 1_000_000;
          const availableUsdc = Number(balance) / 1_000_000;
          throw new X402Error(
            X402ErrorCode.INSUFFICIENT_BALANCE,
            `Insufficient USDC balance. Required: $${requiredUsdc.toFixed(2)}, Available: $${availableUsdc.toFixed(2)}`
          );
        }

        // Generate nonce and validity window
        const nonce = generateNonce();
        const validAfter = BigInt(Math.floor(Date.now() / 1000) - 600);
        const validBefore = BigInt(Math.floor(Date.now() / 1000) + 300);

        const tokenName = paymentOption.extra?.name || "USD Coin";
        const tokenVersion = paymentOption.extra?.version || "2";

        // Sign the authorization
        setPaymentStatus("signing");
        let signedAuth: SignedAuthorizationWithSig;

        if (agentWallet) {
          signedAuth = await signTransferAuthorizationWithAgent(
            agentWallet.accountName,
            payerAddress,
            paymentOption.payTo as Address,
            amountInAtomicUnits,
            validAfter,
            validBefore,
            nonce,
            paymentOption.asset as Address,
            tokenName,
            tokenVersion,
            chainId
          );
        } else {
          signedAuth = await signTransferAuthorization(
            payerAddress,
            paymentOption.payTo as Address,
            amountInAtomicUnits,
            validAfter,
            validBefore,
            nonce,
            paymentOption.asset as Address,
            tokenName,
            tokenVersion,
            chainId
          );
        }

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
      signTransferAuthorization,
      signTransferAuthorizationWithAgent,
      createPaymentPayload,
      generateNonce,
      checkUSDCBalance,
    ]
  );

  /**
   * Make a request that may require payment
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
              errorData.message || "Payment verification failed"
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
    [handlePaymentRequired]
  );

  /**
   * Check if user has already paid for a resource
   */
  const checkExistingPayment = useCallback(
    async (resourceId: string): Promise<boolean> => {
      try {
        const response = await fetch(`/api/x402/check-payment/${resourceId}`, {
          headers: {
            Authorization: `Bearer ${session?.access_token || ""}`,
          },
        });

        if (response.ok) {
          const data = await response.json();
          return data.hasPaid;
        }
        return false;
      } catch (err) {
        console.error("Error checking existing payment:", err);
        return false;
      }
    },
    [session?.access_token]
  );

  return {
    handlePaymentRequired,
    makePaymentRequest,
    checkExistingPayment,
    checkUSDCBalance,
    paymentRequirements,
    paymentStatus,
    isProcessing,
    error,
    isConnected: !!address,
    resetPayment,
  };
};

export default useX402Payment;
