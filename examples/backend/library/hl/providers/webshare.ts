/**
 * Webshare Provider — Proxy-Based Fallback for Rate Limits
 *
 * Secondary provider that routes Hyperliquid API calls through a proxy
 * service. Activated automatically when the primary HlSdk provider
 * returns HTTP 429 (rate limited).
 *
 * Key differences from HlSdk:
 * - Routes through a rotating proxy pool (Webshare)
 * - Manually constructs signed actions instead of using SDK helpers
 * - Same OpenTelemetry instrumentation for monitoring
 *
 * For CCTP, implements:
 * - sendToEvmWithData(): Constructs and signs the CCTP bridge action
 * - userNonFundingLedgerUpdates(): Fetches ledger data through proxy
 *
 * Full implementation is ~713 lines. Only CCTP-relevant methods shown.
 */

import * as hl from "@nktkas/hyperliquid";
import type { HLExchangeProvider, HLInfoProvider } from "../types";
import { Meter, metrics } from "@opentelemetry/api";
import type { LocalAccount } from "viem";

// EIP-712 type definitions for signed exchange actions
const SendToEvmWithDataTypes = {
	// Imported from @nktkas/hyperliquid/api/exchange at runtime
	// Defines the typed data structure for CCTP bridge transactions
};

export class Webshare implements HLInfoProvider, HLExchangeProvider {
	static meter: Meter = metrics.getMeter("hl");
	private wallet: LocalAccount;

	constructor(wallet?: LocalAccount) {
		if (wallet) {
			this.wallet = wallet;
		}
	}

	// ── Proxy routing ──────────────────────────────────────────────────────

	/**
	 * Post an info request through the proxy. Used for read-only queries
	 * like ledger updates and clearinghouse state.
	 */
	private static async postInfo(body: any): Promise<any> {
		// Routes through Webshare proxy pool to avoid rate limits
		// Implementation: HTTP POST to https://api.hyperliquid.xyz/info
		// with proxy rotation headers
		throw new Error("Proxy implementation requires Webshare API key");
	}

	/**
	 * Post a signed exchange action through the proxy. Used for writes
	 * like sendToEvmWithData (CCTP bridge).
	 */
	private async postUserSignedAction(
		action: any,
		types: any,
	): Promise<any> {
		// 1. Construct the action payload with EIP-712 types
		// 2. Sign with the user's wallet (Moon SDK)
		// 3. POST to https://api.hyperliquid.xyz/exchange through proxy
		throw new Error("Proxy implementation requires Webshare API key");
	}

	// ── CCTP-critical methods ──────────────────────────────────────────────

	/**
	 * Send USDC from Hyperliquid to EVM via CCTP (through proxy).
	 * Constructs the sendToEvmWithData action, signs it with the user's
	 * wallet, and broadcasts through the proxy pool.
	 */
	async sendToEvmWithData(
		params: hl.SendToEvmWithDataParameters,
	): Promise<hl.SendToEvmWithDataSuccessResponse> {
		Webshare.meter.createCounter("hl.send-to-evm-with-data.call").add(1);
		Webshare.meter.createCounter("hl.api.weight").add(1);
		return await this.postUserSignedAction(
			{
				...this.baseSignedAction("sendToEvmWithData"),
				...params,
			},
			SendToEvmWithDataTypes,
		);
	}

	/**
	 * Query non-funding ledger updates through proxy.
	 * Used for CCTP transfer detection when the primary SDK is rate limited.
	 */
	async userNonFundingLedgerUpdates(
		params: hl.UserNonFundingLedgerUpdatesParameters,
	): Promise<hl.UserNonFundingLedgerUpdatesResponse> {
		Webshare.meter.createCounter("hl.ledger-updates.call").add(1);
		const data = await Webshare.postInfo({
			type: "userNonFundingLedgerUpdates",
			...params,
		});
		Webshare.meter
			.createCounter("hl.api.weight")
			.add(20 + Math.floor(data.length / 20));
		return data;
	}

	private baseSignedAction(actionType: string): any {
		return {
			type: actionType,
			// Adds nonce, timestamp, and signature metadata
		};
	}

	// Remaining interface methods follow the same pattern:
	// Info methods → Webshare.postInfo({ type: "methodName", ...params })
	// Exchange methods → this.postUserSignedAction(action, types)

	// Stubs for interface compliance (full implementations in source repo)
	async allMids(p: any) { return Webshare.postInfo({ type: "allMids", ...p }); }
	async candleSnapshot(p: any) { return Webshare.postInfo({ type: "candleSnapshot", ...p }); }
	async clearinghouseState(p: any) { return Webshare.postInfo({ type: "clearinghouseState", ...p }); }
	async frontendOpenOrders(p: any) { return Webshare.postInfo({ type: "frontendOpenOrders", ...p }); }
	async fundingHistory(p: any) { return Webshare.postInfo({ type: "fundingHistory", ...p }); }
	async historicalOrders(p: any) { return Webshare.postInfo({ type: "historicalOrders", ...p }); }
	async l2Book(p: any) { return Webshare.postInfo({ type: "l2Book", ...p }); }
	async maxBuilderFee(p: any) { return Webshare.postInfo({ type: "maxBuilderFee", ...p }); }
	async metaAndAssetCtxs(p: any) { return Webshare.postInfo({ type: "metaAndAssetCtxs", ...p }); }
	async orderStatus(p: any) { return Webshare.postInfo({ type: "orderStatus", ...p }); }
	async spotClearinghouseState(p: any) { return Webshare.postInfo({ type: "spotClearinghouseState", ...p }); }
	async spotMeta() { return Webshare.postInfo({ type: "spotMeta" }); }
	async spotMetaAndAssetCtxs() { return Webshare.postInfo({ type: "spotMetaAndAssetCtxs" }); }
	async userFees(p: any) { return Webshare.postInfo({ type: "userFees", ...p }); }
	async userFillsByTime(p: any) { return Webshare.postInfo({ type: "userFillsByTime", ...p }); }
	async userFunding(p: any) { return Webshare.postInfo({ type: "userFunding", ...p }); }
	async approveBuilderFee(p: any) { return this.postUserSignedAction(p, {}); }
	async batchModify(p: any) { return this.postUserSignedAction(p, {}); }
	async cancel(p: any) { return this.postUserSignedAction(p, {}); }
	async order(p: any) { return this.postUserSignedAction(p, {}); }
	async updateLeverage(p: any) { return this.postUserSignedAction(p, {}); }
	async usdClassTransfer(p: any) { return this.postUserSignedAction(p, {}); }
	async usdSend(p: any) { return this.postUserSignedAction(p, {}); }
	async withdraw3(p: any) { return this.postUserSignedAction(p, {}); }
	async agentEnableDexAbstraction() { return this.postUserSignedAction({}, {}); }
}
