/**
 * X402 Server — Payment Library
 *
 * Core server-side library for X402 payment processing. Handles:
 * - Generating 402 Payment Required responses
 * - Verifying payment signatures (basic validation + facilitator)
 * - Settling payments on-chain via the facilitator
 * - Transaction logging via pluggable persistence
 *
 * This class takes a PaymentPersistence and FacilitatorClient via constructor
 * injection, decoupling it from any specific database or settlement service.
 */

import { parseUnits } from "viem";
import type {
  X402PaymentConfig,
  X402PaymentPayload,
  X402PaymentRequirement,
  X402PaymentRequirements,
  X402VerificationResult,
  X402SettlementResult,
} from "../types/protocol";
import {
  NETWORK_REGISTRY,
  getNetworkConfig,
  getSupportedNetworks,
} from "../types/network";
import { decodePaymentHeader } from "../types/utils";
import type {
  PaymentPersistence,
  FacilitatorClient,
  TransactionLogParams,
} from "./interfaces";

// ============================================================================
// Library
// ============================================================================

/**
 * Core server-side library for X402 payment processing.
 *
 * Orchestrates the full payment lifecycle: generating 402 responses,
 * verifying signatures, settling on-chain, and logging transactions.
 * All storage and settlement operations are delegated to injected
 * {@link PaymentPersistence} and {@link FacilitatorClient} implementations.
 *
 * @example
 * ```typescript
 * const library = new X402PaymentLibrary(persistence, facilitator, {
 *   baseUrl: "https://api.example.com",
 * });
 *
 * const requirements = await library.generatePaymentRequirements(
 *   "premium_content", "article-123", "/api/articles/123", 0.10, "0xRecipient...",
 * );
 * ```
 */
export class X402PaymentLibrary {
  /** @internal */
  private persistence: PaymentPersistence;
  /** @internal */
  private facilitator: FacilitatorClient;
  /** @internal */
  private baseUrl: string | null;

  /**
   * Create a new X402PaymentLibrary instance.
   *
   * @param persistence - A {@link PaymentPersistence} implementation for transaction storage.
   * @param facilitator - A {@link FacilitatorClient} implementation for signature verification and settlement.
   * @param options - Optional configuration.
   * @param options.baseUrl - Base URL for constructing absolute resource URLs in payment requirements.
   */
  constructor(
    persistence: PaymentPersistence,
    facilitator: FacilitatorClient,
    options?: { baseUrl?: string },
  ) {
    this.persistence = persistence;
    this.facilitator = facilitator;
    this.baseUrl = options?.baseUrl ?? null;
  }

  /**
   * Set the base URL used to construct absolute resource URLs in payment requirements.
   *
   * @param baseUrl - The base URL (e.g., `"https://api.example.com"`).
   */
  setBaseUrl(baseUrl: string): void {
    this.baseUrl = baseUrl;
  }

  // ========================================================================
  // Payment Requirements Generation
  // ========================================================================

  /**
   * Generate X402 payment requirements for a resource.
   *
   * Builds a complete {@link X402PaymentRequirement} object and persists the
   * associated payment config for future reference.
   *
   * @param resourceType - The type of resource being protected (e.g., "credit_purchase").
   * @param resourceId - Optional identifier for the specific resource instance.
   * @param endpointPath - The API endpoint path (will be converted to an absolute URL).
   * @param amountUsdc - The payment amount in USDC (e.g., `0.10`).
   * @param payToAddress - The Ethereum address to receive the payment.
   * @param options - Optional configuration overrides.
   * @param options.network - Blockchain network to use. Default: `"base"`.
   * @param options.description - Human-readable description for the payment.
   * @param options.scheme - Payment scheme. Default: `"exact"`.
   * @param options.maxTimeoutSeconds - Maximum timeout for the payment. Default: `30`.
   * @param options.mimeType - MIME type of the protected resource. Default: `"application/json"`.
   * @param options.outputSchema - JSON Schema of the expected response body.
   * @param options.baseUrl - Override the library's base URL for this request.
   * @returns The generated {@link X402PaymentRequirement}.
   * @throws {Error} If the specified network is not supported.
   */
  async generatePaymentRequirements(
    resourceType: string,
    resourceId: string | undefined,
    endpointPath: string,
    amountUsdc: number,
    payToAddress: string,
    options?: {
      network?: string;
      description?: string;
      scheme?: string;
      maxTimeoutSeconds?: number;
      mimeType?: string;
      outputSchema?: Record<string, unknown>;
      baseUrl?: string;
    },
  ): Promise<X402PaymentRequirement> {
    const network = options?.network || "base";
    const config = getNetworkConfig(network);

    if (!config) {
      throw new Error(
        `Unsupported network: ${network}. Supported: ${getSupportedNetworks().join(", ")}`,
      );
    }

    const amountWei = parseUnits(amountUsdc.toFixed(6), 6);
    const absoluteUrl = this.toAbsoluteUrl(
      endpointPath,
      options?.baseUrl,
    );

    const requirements: X402PaymentRequirement = {
      scheme: options?.scheme || "exact",
      network,
      maxAmountRequired: amountWei.toString(),
      resource: absoluteUrl,
      description:
        options?.description || `Payment required for ${resourceType}`,
      mimeType: options?.mimeType || "application/json",
      payTo: payToAddress,
      maxTimeoutSeconds: options?.maxTimeoutSeconds || 30,
      asset: config.usdcAddress,
      extra: {
        name: config.usdcName,
        version: config.usdcVersion,
      },
    };

    // Store config for future reference
    await this.persistence.savePaymentConfig({
      resourceType,
      resourceId,
      endpointPath,
      scheme: requirements.scheme as string,
      network,
      chainId: config.chainId,
      assetAddress: config.usdcAddress,
      assetSymbol: "USDC",
      assetDecimals: 6,
      amountRequiredUsdc: amountUsdc,
      payToAddress,
      maxTimeoutSeconds: requirements.maxTimeoutSeconds,
      description: requirements.description ?? "",
      mimeType: requirements.mimeType,
      outputSchema: options?.outputSchema ?? null,
    });

    return requirements;
  }

  /**
   * Create a complete HTTP 402 Payment Required response body.
   *
   * Wraps one or more payment requirements into the standard X402 response envelope.
   *
   * @param requirements - A single requirement or an array of requirements to accept.
   * @param error - Optional error message to include in the response.
   * @returns A fully formed {@link X402PaymentRequirements} response body.
   */
  create402Response(
    requirements: X402PaymentRequirement | X402PaymentRequirement[],
    error?: string,
  ): X402PaymentRequirements {
    return {
      x402Version: 1,
      accepts: Array.isArray(requirements)
        ? requirements
        : [requirements],
      error,
    };
  }

  // ========================================================================
  // Payment Verification
  // ========================================================================

  /**
   * Verify an X402 payment header.
   *
   * Performs basic validation (version, scheme, network, amount, destination,
   * timing window) then delegates to the facilitator for cryptographic
   * EIP-3009 signature verification.
   *
   * @param paymentHeader - The base64-encoded `X-Payment` header value.
   * @param requirements - The payment requirements the header must satisfy.
   * @returns A verification result with `isValid` and optional `invalidReason`.
   */
  async verifyPayment(
    paymentHeader: string,
    requirements: X402PaymentRequirement,
  ): Promise<X402VerificationResult> {
    try {
      const payloadJson = Buffer.from(paymentHeader, "base64").toString(
        "utf-8",
      );
      const payload: X402PaymentPayload = JSON.parse(payloadJson);

      // Basic validation
      if (payload.x402Version !== 1) {
        return {
          isValid: false,
          invalidReason: `Unsupported X402 version: ${payload.x402Version}`,
        };
      }

      if (payload.scheme !== requirements.scheme) {
        return {
          isValid: false,
          invalidReason: `Scheme mismatch: expected ${requirements.scheme}, got ${payload.scheme}`,
        };
      }

      if (payload.network !== requirements.network) {
        return {
          isValid: false,
          invalidReason: `Network mismatch: expected ${requirements.network}, got ${payload.network}`,
        };
      }

      const paymentAmount = BigInt(payload.payload.authorization.value);
      const requiredAmount = BigInt(requirements.maxAmountRequired);
      if (paymentAmount < requiredAmount) {
        return {
          isValid: false,
          invalidReason: `Insufficient payment: ${paymentAmount} < ${requiredAmount}`,
        };
      }

      if (
        payload.payload.authorization.to.toLowerCase() !==
        requirements.payTo.toLowerCase()
      ) {
        return {
          isValid: false,
          invalidReason: "Payment destination mismatch",
        };
      }

      const now = Math.floor(Date.now() / 1000);
      const validAfter = Number.parseInt(
        payload.payload.authorization.validAfter,
      );
      const validBefore = Number.parseInt(
        payload.payload.authorization.validBefore,
      );

      if (now < validAfter) {
        return { isValid: false, invalidReason: "Payment not yet valid" };
      }
      if (now > validBefore) {
        return { isValid: false, invalidReason: "Payment expired" };
      }

      // Delegate cryptographic verification to facilitator
      return await this.facilitator.verify(payload, requirements);
    } catch (error) {
      return {
        isValid: false,
        invalidReason: `Verification error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  // ========================================================================
  // Payment Settlement
  // ========================================================================

  /**
   * Verify and settle a payment on-chain.
   *
   * First verifies the signature via {@link verifyPayment}, then calls the
   * facilitator to execute `transferWithAuthorization` on-chain.
   *
   * @param paymentHeader - The base64-encoded `X-Payment` header value.
   * @param requirements - The payment requirements the header must satisfy.
   * @returns A settlement result with `success`, `txHash`, and optional error info.
   */
  async settlePayment(
    paymentHeader: string,
    requirements: X402PaymentRequirement,
  ): Promise<X402SettlementResult> {
    try {
      // Verify first
      const verification = await this.verifyPayment(
        paymentHeader,
        requirements,
      );
      if (!verification.isValid) {
        return {
          success: false,
          error: verification.invalidReason,
          txHash: null,
          networkId: null,
        };
      }

      // Decode and settle
      const payloadJson = Buffer.from(paymentHeader, "base64").toString(
        "utf-8",
      );
      const payload: X402PaymentPayload = JSON.parse(payloadJson);

      return await this.facilitator.settle(payload, requirements);
    } catch (error) {
      return {
        success: false,
        error: `Settlement error: ${error instanceof Error ? error.message : String(error)}`,
        txHash: null,
        networkId: null,
      };
    }
  }

  // ========================================================================
  // Transaction Logging (delegated to persistence)
  // ========================================================================

  /**
   * Log a payment transaction to the persistence layer.
   *
   * @param params - The transaction details to log. See {@link TransactionLogParams}.
   * @returns The generated transaction ID, or `null` if logging failed.
   */
  async logTransaction(params: TransactionLogParams): Promise<string | null> {
    return this.persistence.logTransaction(params);
  }

  /**
   * Retrieve a stored payment configuration from the persistence layer.
   *
   * @param resourceType - The type of resource (e.g., "credit_purchase").
   * @param endpointPath - The API endpoint path.
   * @param network - Optional network filter.
   * @returns The matching payment config, or `null` if not found.
   */
  async getPaymentConfig(
    resourceType: string,
    endpointPath: string,
    network?: string,
  ): Promise<X402PaymentConfig | null> {
    return this.persistence.getPaymentConfig(
      resourceType,
      endpointPath,
      network,
    );
  }

  // ========================================================================
  // Helpers
  // ========================================================================

  /**
   * Get the list of all supported network names.
   *
   * @returns An array of supported network name strings.
   */
  getSupportedNetworks(): string[] {
    return getSupportedNetworks();
  }

  /**
   * Convert a relative path to an absolute URL using the configured base URL.
   *
   * @param path - The path or URL to convert.
   * @param baseUrl - Optional base URL override.
   * @returns The absolute URL string.
   * @internal
   */
  private toAbsoluteUrl(path: string, baseUrl?: string): string {
    if (path.startsWith("http://") || path.startsWith("https://")) {
      return path;
    }
    const base = baseUrl || this.baseUrl || "https://localhost";
    const cleanBase = base.replace(/\/$/, "");
    const cleanPath = path.startsWith("/") ? path : `/${path}`;
    return `${cleanBase}${cleanPath}`;
  }
}
