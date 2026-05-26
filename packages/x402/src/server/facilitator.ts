/**
 * X402 Server — Default Facilitator Client
 *
 * HTTP client for the X402 facilitator service that handles:
 * - Cryptographic signature verification (EIP-3009)
 * - On-chain settlement (transferWithAuthorization)
 *
 * Default facilitator: https://facilitator.payai.network
 * Based on Coinbase's X402 specification: https://github.com/coinbase/x402
 */

import type {
  X402PaymentPayload,
  X402PaymentRequirement,
  X402VerificationResult,
  X402SettlementResult,
  X402FacilitatorVerifyRequest,
  X402FacilitatorSettleRequest,
  X402FacilitatorVerifyResponse,
  X402FacilitatorSettleResponse,
} from "../types/protocol";
import type { FacilitatorClient } from "./interfaces";

// ============================================================================
// Default Implementation
// ============================================================================

/**
 * Default HTTP-based facilitator client.
 *
 * Communicates with the X402 facilitator service (default: Coinbase's facilitator
 * at `https://facilitator.payai.network`) to verify EIP-3009 signatures and
 * settle payments on-chain via `transferWithAuthorization`.
 *
 * Includes automatic retry logic with exponential backoff for transient failures.
 *
 * @example
 * ```typescript
 * const facilitator = new DefaultFacilitatorClient();
 * const result = await facilitator.verify(payload, requirements);
 * ```
 */
export class DefaultFacilitatorClient implements FacilitatorClient {
  /** @internal */
  private url: string;
  /** @internal */
  private retryAttempts: number;
  /** @internal */
  private retryDelayMs: number;

  /**
   * Create a new DefaultFacilitatorClient.
   *
   * @param facilitatorUrl - The facilitator service URL. Default: `"https://facilitator.payai.network"`.
   * @param options - Optional retry configuration.
   * @param options.retryAttempts - Number of retry attempts on failure. Default: `3`.
   * @param options.retryDelayMs - Base delay between retries in milliseconds (multiplied by attempt number). Default: `1000`.
   */
  constructor(
    facilitatorUrl = "https://facilitator.payai.network",
    options?: {
      retryAttempts?: number;
      retryDelayMs?: number;
    },
  ) {
    this.url = facilitatorUrl;
    this.retryAttempts = options?.retryAttempts ?? 3;
    this.retryDelayMs = options?.retryDelayMs ?? 1000;
  }

  /**
   * Verify a payment signature via the facilitator service without executing on-chain.
   *
   * Normalizes the payload (handles legacy split-signature format) before sending.
   *
   * @param payload - The decoded X402 payment payload.
   * @param requirements - The payment requirements to verify against.
   * @returns A verification result with `isValid` and optional `invalidReason`.
   */
  async verify(
    payload: X402PaymentPayload,
    requirements: X402PaymentRequirement,
  ): Promise<X402VerificationResult> {
    const normalized = normalizePaymentPayload(payload);

    const requestBody: X402FacilitatorVerifyRequest = {
      paymentPayload: normalized,
      paymentRequirements: requirements,
    };

    try {
      const response = await this.fetchWithRetry(`${this.url}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      const result: X402FacilitatorVerifyResponse = await response.json();

      return {
        isValid: result.isValid ?? false,
        invalidReason: result.invalidReason || null,
        payer: result.payer,
        amount: result.amount,
      };
    } catch (error) {
      return {
        isValid: false,
        invalidReason: `Facilitator verify error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Verify and settle a payment on-chain via the facilitator service.
   *
   * Normalizes the payload and sends it to the facilitator's `/settle` endpoint,
   * which executes `transferWithAuthorization` on-chain.
   *
   * @param payload - The decoded X402 payment payload.
   * @param requirements - The payment requirements to verify and settle against.
   * @returns A settlement result with `success`, `txHash`, and optional error info.
   */
  async settle(
    payload: X402PaymentPayload,
    requirements: X402PaymentRequirement,
  ): Promise<X402SettlementResult> {
    const normalized = normalizePaymentPayload(payload);

    const requestBody: X402FacilitatorSettleRequest = {
      x402Version: 1,
      paymentPayload: normalized,
      paymentRequirements: requirements,
    };

    try {
      const response = await this.fetchWithRetry(`${this.url}/settle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      const result: X402FacilitatorSettleResponse = await response.json();

      return {
        success: result.success,
        error: result.error || null,
        txHash: result.transaction || null,
        networkId: result.networkId || null,
        payer: result.payer,
        amount: result.amount,
      };
    } catch (error) {
      return {
        success: false,
        error: `Facilitator settle error: ${error instanceof Error ? error.message : String(error)}`,
        txHash: null,
        networkId: null,
      };
    }
  }

  /**
   * Fetch with retry logic. Retries on network errors and 5xx responses
   * with linear backoff (delay * attempt number).
   *
   * @param url - The URL to fetch.
   * @param init - Standard fetch RequestInit options.
   * @returns The Response object from a successful or non-5xx response.
   * @throws {Error} If all retry attempts are exhausted.
   * @internal
   */
  private async fetchWithRetry(
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.retryAttempts; attempt++) {
      try {
        const response = await fetch(url, {
          ...init,
          signal: AbortSignal.timeout(15_000),
        });

        if (response.ok || response.status < 500) {
          return response;
        }

        lastError = new Error(
          `Facilitator returned ${response.status}: ${await response.text().catch(() => "unknown")}`,
        );
      } catch (err) {
        lastError =
          err instanceof Error ? err : new Error(String(err));
      }

      if (attempt < this.retryAttempts - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, this.retryDelayMs * (attempt + 1)),
        );
      }
    }

    throw lastError || new Error("Facilitator request failed");
  }
}

// ============================================================================
// Payload Normalization
// ============================================================================

/**
 * Normalize a payment payload to ensure the signature is in combined format.
 * Handles both formats:
 * - Combined: `{ signature: "0x..." }` (preferred)
 * - Split: `{ authorization: { v, r, s } }` (legacy)
 */
function normalizePaymentPayload(
  payload: X402PaymentPayload,
): X402PaymentPayload {
  // Check for legacy split-signature format (v, r, s on the authorization object)
  const auth = payload.payload.authorization as Record<string, unknown>;
  const hasSplitSig =
    "v" in auth &&
    "r" in auth &&
    "s" in auth &&
    !payload.payload.signature;

  if (hasSplitSig) {
    const rStr = String(auth.r);
    const sStr = String(auth.s);
    const r = rStr.startsWith("0x") ? rStr.slice(2) : rStr;
    const s = sStr.startsWith("0x") ? sStr.slice(2) : sStr;
    const vHex =
      typeof auth.v === "number"
        ? auth.v.toString(16).padStart(2, "0")
        : String(auth.v);

    const combinedSignature = `0x${r}${s}${vHex}`;

    // Return clean payload without v, r, s on authorization
    const { v: _v, r: _r, s: _s, ...cleanAuth } = auth;
    return {
      ...payload,
      payload: {
        signature: combinedSignature,
        authorization: cleanAuth,
      },
    };
  }

  return payload;
}
