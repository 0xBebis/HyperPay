/**
 * Billing Controller — CCTP & X402 Credit Purchase Flows
 *
 * This file contains the cross-chain payment endpoints that allow users to
 * purchase platform credits using:
 *
 * 1. CCTP via Hyperliquid: Users with USDC in their HL perp margin can
 *    purchase credits in a single API call. The controller orchestrates
 *    the CCTP bridge (HL → Base) and verifies settlement via dual-polling.
 *
 * 2. X402 Protocol: Users with a Web3 wallet sign an EIP-3009
 *    transferWithAuthorization (gasless) on Base, and the backend settles
 *    the payment on-chain.
 *
 * Extracted from the full billing controller for hackathon submission.
 * Non-CCTP payment flows (Coinbase Commerce, subscription renewals, etc.)
 * are omitted.
 */

import axios from "axios";
import type { SupabaseClient } from "@supabase/supabase-js";
import { type Address } from "viem";
import { trace, type Tracer } from "@opentelemetry/api";
import { Route, Tags, Security, Post, Path, Body, Request, Res } from "tsoa";
import type { TsoaResponse } from "tsoa";

import { HLExchange } from "../library/hl/exchange";
import { VaultPubSub } from "../library/pubsub";
import { getServiceClient } from "../library/supabase";
import { PlanService } from "../services/PlanService";
import { BillingModelService } from "../services/BillingModelService";
import { NotificationService } from "../services/NotificationService";
import { ReferralsController } from "./referrals.Controller";
import { calculateFinalAmount, maybeGrantReferralBonus } from "../library/billing-utils";

// ============================================================================
// Types
// ============================================================================

interface PurchaseCreditsBody {
	packageId: string;
}

interface CustomRequest {
	user: { id: string };
	headers: { authorization: string; "x-account-id"?: string };
	supabase: SupabaseClient;
	pubsub: VaultPubSub;
	x402Payment?: {
		verified: boolean;
		settled: boolean;
		transactionId: string;
	};
}

/**
 * Across Protocol transfer record — used to verify CCTP settlement on the
 * destination chain. The indexer tracks HL→EVM CCTP transfers and returns
 * the source/destination tx hashes once the fill is confirmed.
 */
interface AccrossTransfer {
	depositTxnRef: string | null;
	fillTxnRef: string | null;
	originChainId: number;
	destinationChainId: number;
	nonce: string; // HL nonce
	destinationBlockTimestamp: string; // ISO 8601
}

// ============================================================================
// Controller
// ============================================================================

@Route("billing")
@Tags("Billing")
export class BillingController {
	private static readonly X402_WALLET_ADDRESS =
		"0x87f1d896e39f0629c7a391d255364ed9C4a47Da0";

	/**
	 * CCTP chain configuration. Each entry maps a chain name to its CCTP
	 * domain ID (used by HL's sendToEvmWithData) and EVM chain ID (used to
	 * verify the fill on the destination chain via the Across indexer).
	 */
	private readonly CCTP_CHAINS = {
		arc: {
			destinationChainId: 26,
			evmChainId: 0, // @todo enter chain id when known
		},
		base: {
			destinationChainId: 6,
			evmChainId: 8453,
		},
	};
	private readonly CCTP_CONFIG = this.CCTP_CHAINS.base;

	public declare supabase: SupabaseClient;
	private pubsub: VaultPubSub;
	private planService: PlanService;
	private billingModelService: BillingModelService;
	private notificationService: NotificationService;
	private tracer: Tracer;

	constructor() {
		this.supabase = getServiceClient();
		this.pubsub = VaultPubSub.getInstance();
		this.planService = new PlanService(this.supabase);
		this.billingModelService = new BillingModelService(this.supabase);
		this.notificationService = new NotificationService(this.supabase, this.pubsub);
		this.tracer = trace.getTracer("billing-controller");
	}

	// ========================================================================
	// Helpers
	// ========================================================================

	public static getPaymentAddressForCreditPayments(): string {
		return this.X402_WALLET_ADDRESS;
	}

	private async hasPermission(
		supabase: SupabaseClient,
		accountId: string,
	): Promise<boolean> {
		const { data: accountData } = await supabase.rpc("get_account", {
			account_id: accountId,
		});
		if (
			!accountData ||
			!["owner", "billing_admin"].includes(accountData.account_role)
		) {
			return false;
		}
		return true;
	}

	// ========================================================================
	// X402 Credit Purchase (Gasless USDC on Base)
	// ========================================================================

	/**
	 * Complete a credit purchase using the X402 payment protocol.
	 *
	 * The frontend signs an EIP-3009 transferWithAuthorization and sends it
	 * in the X-Payment header. By the time this endpoint runs, middleware has
	 * already verified the signature and executed the on-chain transfer.
	 *
	 * This endpoint atomically records the payment and updates the user's
	 * credit balance via the settle_x402_credit_purchase PostgreSQL function.
	 */
	@Security("jwt")
	@Post("x402/credits/purchase")
	public async completeX402CreditPurchase(
		@Body() body: PurchaseCreditsBody,
		@Request() req: CustomRequest,
		@Res() badRequest: TsoaResponse<400 | 403 | 500 | 501, { error: string }>,
	): Promise<{ success: boolean; credits: number; transactionId: string }> {
		const accountId = req.headers["x-account-id"] as string;
		const { packageId } = body;

		if (!this.hasPermission(req.supabase, accountId)) {
			return badRequest(403, {
				error: "Only owners or billing admins can purchase credits",
			});
		}

		// Verify X402 payment is settled
		if (
			!req.x402Payment ||
			!req.x402Payment.verified ||
			!req.x402Payment.settled
		) {
			if (!req.x402Payment) {
				throw new Error("X402 payment information is missing");
			}
			if (!req.x402Payment.verified) {
				throw new Error("X402 payment is not verified");
			}
			if (!req.x402Payment.settled) {
				throw new Error("X402 payment is not settled");
			}
		}

		const packageCalculations = await calculateFinalAmount(
			req.supabase,
			packageId,
		);
		if (packageCalculations.success === false) {
			return badRequest(400, { error: packageCalculations.error });
		}

		const {
			amount: finalAmount,
			credits,
			packageId: resolvedPackageId,
		} = packageCalculations;

		// Atomically record X402 payment and update credits
		const { data, error } = await this.supabase.rpc(
			"settle_x402_credit_purchase",
			{
				p_account_id: accountId,
				p_provider_charge_id: req.x402Payment.transactionId,
				p_amount: finalAmount,
				p_credits: credits,
				p_credit_package_id: resolvedPackageId,
			},
		);

		if (error) {
			throw new Error("Settlement failed: [see logs]");
		}

		const refController = new ReferralsController();
		await refController.onPaymentCompleted({
			transaction: req.x402Payment.transactionId,
			amount: finalAmount,
			referred: req.user.id,
			type: "credit_purchase",
		});

		await maybeGrantReferralBonus(this.supabase, accountId, credits, data.id);

		req.pubsub.emit(`credits.added.${accountId}`, {
			chargeId: req.x402Payment.transactionId,
			amount: finalAmount,
			credits,
		});

		await this.notificationService.notifyCreditPurchaseCompleted({
			userId: req.user.id,
			accountId,
			amount: finalAmount,
			credits,
			chargeId: req.x402Payment.transactionId,
		});

		return {
			success: true,
			credits,
			transactionId: data.id,
		};
	}

	// ========================================================================
	// CCTP Credit Purchase (Hyperliquid → Base via Circle CCTP)
	// ========================================================================

	/**
	 * Purchase credits by bridging USDC from Hyperliquid to Base via CCTP.
	 *
	 * Flow:
	 * 1. Initiate CCTP transfer via HLExchange.sendToEvmWithData()
	 * 2. Poll HL ledger for the deposit operation (source-side confirmation)
	 * 3. Poll Across indexer for the fill operation (destination-side confirmation)
	 * 4. Atomically settle payment and grant credits
	 *
	 * The `data: "0x"` parameter enables automatic forwarding on the destination
	 * chain, so the recipient doesn't need gas on Base to receive the USDC.
	 */
	@Security("jwt")
	@Post("hl/{account}/credits/purchase")
	public async hlCreditPurchase(
		@Path() account: string,
		@Body() body: PurchaseCreditsBody,
		@Request() req: CustomRequest,
		@Res() badRequest: TsoaResponse<400 | 403 | 500 | 501, { error: string }>,
	): Promise<{ success: boolean; credits: number; transactionId: string }> {
		const accountId = req.user.id;
		const { packageId } = body;

		if (!this.hasPermission(req.supabase, accountId)) {
			return badRequest(403, {
				error: "Only owners or billing admins can purchase credits",
			});
		}

		const packageCalculations = await calculateFinalAmount(
			req.supabase,
			packageId,
		);
		if (packageCalculations.success === false) {
			return badRequest(400, { error: packageCalculations.error });
		}

		const {
			amount: finalAmount,
			credits,
			packageId: resolvedPackageId,
		} = packageCalculations;

		// ── Step 1: Initiate CCTP transfer ─────────────────────────────────

		const hlExchange = new HLExchange(
			account as Address,
			req.supabase,
			req.user,
			req.headers.authorization as string,
		);
		await hlExchange.initialize();

		const now = Date.now();

		const purchase = await hlExchange.sendToEvmWithData({
			token: "USDC",
			amount: finalAmount.toString(),
			sourceDex: "", // Perp margin
			destinationRecipient:
				BillingController.getPaymentAddressForCreditPayments(),
			addressEncoding: "hex",
			destinationChainId: this.CCTP_CONFIG.destinationChainId,
			gasLimit: 200000,
			// "0x" enables automatic forwarding on the destination so we don't
			// need gas on destination chain
			data: "0x",
		});
		if (purchase.status !== "ok") {
			throw new Error("Payment failed: Hyperliquid transaction rejected");
		}

		// ── Step 2-3: Verify settlement on destination chain ───────────────
		// Dual-poll: first find the withdrawal on HL, then the fill on Base.

		let tries = 0;
		const depositTx: { hash: string | null; nonce: number } = {
			hash: null,
			nonce: 0,
		};
		const fillTx: { hash: string | null } = { hash: null };

		while (true) {
			if (!depositTx.hash) {
				// Source-side: find the CCTP withdrawal in HL's ledger
				const withdrawal = await this.findDepositOperation(
					hlExchange,
					account,
					now,
					finalAmount,
				);
				if (withdrawal) {
					depositTx.hash = withdrawal.hash;
					depositTx.nonce = withdrawal.nonce;
				}
			}

			if (depositTx.nonce && !fillTx.hash) {
				// Destination-side: find the fill on the target chain
				const transfer = await this.findFillOperation(account, depositTx);
				if (transfer?.fillTxnRef) {
					fillTx.hash = transfer.fillTxnRef;
				}
			}

			if (fillTx.hash) {
				// Payment settled on destination chain
				break;
			}

			tries++;
			await new Promise((resolve) => setTimeout(resolve, 2000));
			if (tries >= 150) {
				// 5 minutes elapsed
				throw new Error("Payment failed: [see logs]");
			}
		}

		// ── Step 4: Atomic settlement ──────────────────────────────────────

		const chargeId = `${account}=${depositTx.nonce}`;

		const { data, error } = await this.supabase.rpc(
			"settle_cctp_credit_purchase",
			{
				p_account_id: accountId,
				p_provider_charge_id: chargeId,
				p_amount: finalAmount,
				p_credits: credits,
				p_credit_package_id: resolvedPackageId,
			},
		);

		if (error) {
			throw new Error("Settlement failed: [see logs]");
		}

		const refController = new ReferralsController();
		await refController.onPaymentCompleted({
			transaction: chargeId,
			amount: finalAmount,
			referred: req.user.id,
			type: "credit_purchase",
		});

		await maybeGrantReferralBonus(this.supabase, accountId, credits, data.id);

		req.pubsub.emit(`credits.added.${accountId}`, {
			chargeId: chargeId,
			amount: finalAmount,
			credits,
		});

		await this.notificationService.notifyCreditPurchaseCompleted({
			userId: req.user.id,
			accountId,
			amount: finalAmount,
			credits,
			chargeId: chargeId,
		});

		return {
			success: true,
			credits,
			transactionId: data.id,
		};
	}

	// ========================================================================
	// CCTP Verification Helpers
	// ========================================================================

	/**
	 * Find the CCTP deposit operation in Hyperliquid's ledger.
	 *
	 * Queries the user's non-funding ledger updates and filters for CCTP
	 * transfers (sends to the magic bridge address 0x2000...0000) that match
	 * the expected token and amount.
	 */
	private async findDepositOperation(
		hlExchange: HLExchange,
		account: string,
		now: number,
		finalAmount: number,
	): Promise<{ hash: string | null; nonce: number } | null> {
		const withdrawals = await hlExchange.getCCTPTransfers(
			account as Address,
			now,
		);
		const withdrawal = withdrawals.find(
			(withdrawal) =>
				(withdrawal as any).delta.token === "USDC" &&
				+(withdrawal as any).delta.amount === finalAmount,
		);
		if (withdrawal) {
			return {
				hash: (withdrawal as any).hash,
				nonce: (withdrawal as any).delta.nonce,
			};
		}
		return null;
	}

	/**
	 * Find the fill operation on the destination chain via the Across indexer.
	 *
	 * The Across Protocol indexes Hyperliquid CCTP transfers. We query for
	 * transfers from HyperEVM (chainId 999) to our configured destination chain,
	 * matching on the HL nonce for ordering correctness.
	 */
	private async findFillOperation(
		account: string,
		depositTx: { hash: string | null; nonce: number },
	) {
		const transfers: { data: AccrossTransfer[] } = await axios.get(
			`https://indexer.api.across.to/hyperliquid-transfers?direction=out&user=${account}`,
		);
		const transfer = transfers.data.find(
			(transfer: AccrossTransfer) =>
				transfer.originChainId === 999 && // HyperEVM
				transfer.destinationChainId === this.CCTP_CONFIG.evmChainId &&
				transfer.nonce === depositTx.nonce.toString(),
		);
		return transfer;
	}
}
