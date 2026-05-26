/**
 * X402 Server — Express Middleware
 *
 * Drop-in Express middleware that protects endpoints with X402 payments.
 * Handles the complete payment lifecycle:
 *
 * 1. Check for existing payment (permanent access mode)
 * 2. Return HTTP 402 with payment requirements (if no X-Payment header)
 * 3. Verify + settle payment via facilitator, attach result to request
 *
 * ## Usage
 *
 * ```typescript
 * import { createX402Middleware, X402PaymentLibrary, DefaultFacilitatorClient } from "@cod3x/x402/server";
 *
 * const persistence = new YourPersistenceAdapter(db);
 * const facilitator = new DefaultFacilitatorClient();
 * const library = new X402PaymentLibrary(persistence, facilitator, { baseUrl: "https://api.example.com" });
 *
 * app.post("/premium",
 *   createX402Middleware({
 *     library,
 *     persistence,
 *     resourceType: "premium_content",
 *     accessMode: "per_use",
 *     getPayToAddress: () => "0xYOUR_WALLET",
 *     getAmount: () => 0.10, // $0.10 USDC
 *   }),
 *   (req, res) => {
 *     // req.x402Payment is populated
 *     res.json({ content: "premium stuff" });
 *   }
 * );
 * ```
 */

import type { X402PaymentLibrary } from "./library";
import type {
  PaymentPersistence,
  X402MiddlewareOptions,
} from "./interfaces";
import type { X402PaymentInfo, X402PaymentPayload } from "../types/protocol";
import { decodePaymentHeader } from "../types/utils";
import { getNetworkConfig } from "../types/network";

// ============================================================================
// Request Extension
// ============================================================================

/**
 * Extension interface for Express request objects.
 *
 * The X402 middleware attaches `x402Payment` to the request object after
 * successful payment verification/settlement. Merge this with your request
 * type to access payment info in downstream handlers.
 *
 * @example
 * ```typescript
 * app.post("/premium", x402Middleware, (req: Request & X402Request, res) => {
 *   if (req.x402Payment?.settled) {
 *     res.json({ content: "premium stuff", txHash: req.x402Payment.txHash });
 *   }
 * });
 * ```
 */
export interface X402Request {
  /** Payment info populated by the X402 middleware after successful verification/settlement. */
  x402Payment?: X402PaymentInfo;
}

// ============================================================================
// Middleware Factory
// ============================================================================

/**
 * Create an Express middleware that protects an endpoint with X402 payments.
 *
 * The middleware handles three phases:
 * 1. **Existing payment check** -- In `permanent` or `subscription` mode, checks if the
 *    user already has a valid payment and grants access without re-payment.
 * 2. **402 response** -- If no `X-Payment` header is present, returns HTTP 402 with
 *    payment requirements.
 * 3. **Verify + settle** -- Decodes the `X-Payment` header, settles the payment on-chain,
 *    logs the transaction, and attaches payment info to `req.x402Payment`.
 *
 * @param options - Combined middleware and library configuration.
 * @param options.library - An initialized {@link X402PaymentLibrary} instance.
 * @param options.persistence - A {@link PaymentPersistence} implementation.
 * @param options.network - Network to accept payments on. Default: `"base"`.
 * @returns An Express middleware function `(req, res, next) => void`.
 *
 * @example
 * ```typescript
 * app.post("/premium",
 *   createX402Middleware({
 *     library,
 *     persistence,
 *     resourceType: "premium_content",
 *     accessMode: "per_use",
 *     getPayToAddress: () => "0xYOUR_WALLET",
 *     getAmount: () => 0.10,
 *   }),
 *   (req, res) => {
 *     res.json({ content: "premium stuff" });
 *   }
 * );
 * ```
 */
export function createX402Middleware(
  options: X402MiddlewareOptions & {
    library: X402PaymentLibrary;
    persistence: PaymentPersistence;
    /** Network to accept payments on (default: "base"). */
    network?: string;
  },
) {
  const {
    library,
    persistence,
    resourceType,
    accessMode = "per_use",
    getResourceId,
    getPayToAddress,
    getAmount,
    getUserId,
    network = "base",
    logger = console,
  } = options;

  return async (req: any, res: any, next: any) => {
    try {
      const paymentHeader =
        req.headers["x-payment"] || req.headers["X-Payment"];
      const resourceId = getResourceId?.(req) || undefined;
      const userId = getUserId?.(req) || req.user?.id;

      // ── Phase 1: Check for existing payment (permanent mode) ────────

      if (
        !paymentHeader &&
        userId &&
        resourceId &&
        accessMode !== "per_use"
      ) {
        const existing = await persistence.findExistingPayment({
          resourceType,
          resourceId,
          payerUserId: userId,
          statuses: ["verified", "settled"],
        });

        if (existing) {
          (req as X402Request).x402Payment = {
            transactionId: existing.id,
            verified: true,
            settled: existing.status === "settled",
            existingPayment: true,
            accessMode,
            paymentDate: existing.created_at,
            amountPaid: existing.amount_usdc,
            txHash: existing.tx_hash ?? undefined,
          };
          return next();
        }
      }

      // ── Phase 2: Return 402 Payment Required ────────────────────────

      if (!paymentHeader) {
        const amount = await getAmount(req);
        const payTo = await getPayToAddress(req);

        const requirements = await library.generatePaymentRequirements(
          resourceType,
          resourceId,
          req.originalUrl || req.url,
          amount,
          payTo,
          {
            network,
            description: `Payment required for ${resourceType}`,
          },
        );

        const response = library.create402Response(requirements);
        return res.status(402).json(response);
      }

      // ── Phase 3: Verify + Settle Payment ────────────────────────────

      // Decode header first — reject malformed payloads before settlement
      const payment = decodePaymentHeader(paymentHeader);
      if (!payment) {
        return res.status(400).json({
          success: false,
          message: "Invalid X-Payment header — could not decode base64 payload",
        });
      }

      const amount = await getAmount(req);
      const payTo = await getPayToAddress(req);

      const requirements = await library.generatePaymentRequirements(
        resourceType,
        resourceId,
        req.originalUrl || req.url,
        amount,
        payTo,
        { network },
      );

      // Settle (which internally verifies first)
      const settlement = await library.settlePayment(
        paymentHeader,
        requirements,
      );

      if (!settlement.success) {
        return res.status(400).json({
          success: false,
          message: settlement.error || "Payment settlement failed",
        });
      }

      const networkConfig = getNetworkConfig(network);

      // Log transaction
      const transactionId = await library.logTransaction({
        resourceType,
        resourceId,
        paymentPayload: payment,
        paymentRequirements: requirements,
        status: "settled",
        txHash: settlement.txHash,
        network,
        chainId: networkConfig?.chainId,
        payerAddress: payment.payload.authorization.from,
        recipientAddress: payment.payload.authorization.to,
        amountWei: payment.payload.authorization.value,
        payerUserId: userId,
      });

      // Attach payment info to request
      (req as X402Request).x402Payment = {
        transactionId: transactionId || "",
        verified: true,
        settled: true,
        payer: settlement.payer,
        amount: settlement.amount,
        txHash: settlement.txHash ?? undefined,
        networkId: settlement.networkId ?? undefined,
      };

      // Set response header with settlement info
      if (settlement.txHash) {
        const paymentResponse = {
          txHash: settlement.txHash,
          status: "settled",
          networkId: settlement.networkId,
          payer: settlement.payer,
          amount: settlement.amount,
        };
        res.setHeader(
          "X-Payment-Response",
          Buffer.from(JSON.stringify(paymentResponse)).toString("base64"),
        );
      }

      next();
    } catch (error) {
      logger.error("[x402] Middleware error:", error);
      res.status(500).json({
        success: false,
        message: "Internal payment processing error",
      });
    }
  };
}
