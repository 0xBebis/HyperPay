/**
 * HlSdk Provider — Official Hyperliquid SDK Implementation
 *
 * Primary provider for all Hyperliquid API interactions. Uses the
 * @nktkas/hyperliquid SDK's InfoClient and ExchangeClient directly.
 *
 * Every method call is tracked via OpenTelemetry counters for:
 * - Call frequency per endpoint
 * - Estimated API weight (HL has rate limits based on weight)
 *
 * The CCTP-critical methods are:
 * - sendToEvmWithData(): Initiates CCTP bridge from HL to EVM chains
 * - userNonFundingLedgerUpdates(): Queries ledger for CCTP transfer verification
 */

import * as hl from "@nktkas/hyperliquid";
import type { HLExchangeProvider, HLInfoProvider } from "../types";
import { Meter, metrics } from "@opentelemetry/api";
import type { LocalAccount } from "viem";

const HL_IS_TESTNET = false; // Production mainnet

export class HlSdk implements HLInfoProvider, HLExchangeProvider {
	static infoClient: hl.InfoClient = new hl.InfoClient({
		transport: new hl.HttpTransport(),
	});
	private exchangeClient: hl.ExchangeClient;
	static meter: Meter = metrics.getMeter("hl");

	constructor(wallet?: LocalAccount) {
		if (wallet) {
			this.exchangeClient = new hl.ExchangeClient({
				wallet,
				transport: new hl.HttpTransport({
					isTestnet: HL_IS_TESTNET,
				}),
			});
		}
	}

	// ── Info endpoints ─────────────────────────────────────────────────────

	async allMids(params: hl.AllMidsParameters): Promise<hl.AllMidsResponse> {
		HlSdk.meter.createCounter("hl.all-mids.call").add(1);
		HlSdk.meter.createCounter("hl.api.weight").add(2);
		return await HlSdk.infoClient.allMids(params);
	}

	async clearinghouseState(
		params: hl.ClearinghouseStateParameters,
	): Promise<hl.ClearinghouseStateResponse> {
		HlSdk.meter.createCounter("hl.clearinghouse-state.call").add(1);
		HlSdk.meter.createCounter("hl.api.weight").add(2);
		return await HlSdk.infoClient.clearinghouseState(params);
	}

	async spotClearinghouseState(
		params: hl.SpotClearinghouseStateParameters,
	): Promise<hl.SpotClearinghouseStateResponse> {
		HlSdk.meter.createCounter("hl.spot-clearinghouse-state.call").add(1);
		HlSdk.meter.createCounter("hl.api.weight").add(2);
		return await HlSdk.infoClient.spotClearinghouseState(params);
	}

	/**
	 * Query non-funding ledger updates — critical for CCTP transfer detection.
	 * Weight scales with result size: base 20 + 1 per 20 records.
	 */
	async userNonFundingLedgerUpdates(
		params: hl.UserNonFundingLedgerUpdatesParameters,
	): Promise<hl.UserNonFundingLedgerUpdatesResponse> {
		HlSdk.meter.createCounter("hl.ledger-updates.call").add(1);
		const data =
			await HlSdk.infoClient.userNonFundingLedgerUpdates(params);
		HlSdk.meter
			.createCounter("hl.api.weight")
			.add(20 + Math.floor(data.length / 20));
		return data;
	}

	// ── Exchange endpoints ─────────────────────────────────────────────────

	async order(
		params: hl.OrderParameters,
	): Promise<hl.OrderSuccessResponse> {
		HlSdk.meter.createCounter("hl.order.call").add(1);
		HlSdk.meter
			.createCounter("hl.api.weight")
			.add(1 + Math.floor(params.orders.length / 40));
		return await this.exchangeClient.order(params);
	}

	async cancel(
		params: hl.CancelParameters,
	): Promise<hl.CancelSuccessResponse> {
		HlSdk.meter.createCounter("hl.cancel.call").add(1);
		HlSdk.meter
			.createCounter("hl.api.weight")
			.add(1 + Math.floor(params.cancels.length / 40));
		return await this.exchangeClient.cancel(params);
	}

	/**
	 * Send USDC from Hyperliquid to an EVM chain via Circle CCTP.
	 * This is the primary method used by the billing CCTP flow.
	 * Weight: 1 (lightweight — the heavy work happens on-chain).
	 */
	async sendToEvmWithData(
		params: hl.SendToEvmWithDataParameters,
	): Promise<hl.SendToEvmWithDataSuccessResponse> {
		HlSdk.meter.createCounter("hl.send-to-evm-with-data.call").add(1);
		HlSdk.meter.createCounter("hl.api.weight").add(1);
		return await this.exchangeClient.sendToEvmWithData(params);
	}

	async updateLeverage(
		params: hl.UpdateLeverageParameters,
	): Promise<hl.UpdateLeverageSuccessResponse> {
		HlSdk.meter.createCounter("hl.update-leverage.call").add(1);
		HlSdk.meter.createCounter("hl.api.weight").add(1);
		return await this.exchangeClient.updateLeverage(params);
	}

	async approveBuilderFee(
		params: hl.ApproveBuilderFeeParameters,
	): Promise<hl.ApproveBuilderFeeSuccessResponse> {
		HlSdk.meter.createCounter("hl.approve-builder-fee.call").add(1);
		HlSdk.meter.createCounter("hl.api.weight").add(1);
		return await this.exchangeClient.approveBuilderFee(params);
	}

	async batchModify(
		params: hl.BatchModifyParameters,
	): Promise<hl.BatchModifySuccessResponse> {
		HlSdk.meter.createCounter("hl.batch-modify.call").add(1);
		HlSdk.meter
			.createCounter("hl.api.weight")
			.add(1 + Math.floor(params.modifies.length / 40));
		return await this.exchangeClient.batchModify(params);
	}

	async usdClassTransfer(
		params: hl.UsdClassTransferParameters,
	): Promise<hl.UsdClassTransferSuccessResponse> {
		HlSdk.meter.createCounter("hl.usd-class-transfer.call").add(1);
		HlSdk.meter.createCounter("hl.api.weight").add(1);
		return await this.exchangeClient.usdClassTransfer(params);
	}

	async usdSend(
		params: hl.UsdSendParameters,
	): Promise<hl.UsdSendSuccessResponse> {
		HlSdk.meter.createCounter("hl.usd-send.call").add(1);
		HlSdk.meter.createCounter("hl.api.weight").add(1);
		return await this.exchangeClient.usdSend(params);
	}

	async withdraw3(
		params: hl.Withdraw3Parameters,
	): Promise<hl.Withdraw3SuccessResponse> {
		HlSdk.meter.createCounter("hl.withdraw-3.call").add(1);
		HlSdk.meter.createCounter("hl.api.weight").add(1);
		return await this.exchangeClient.withdraw3(params);
	}

	// Remaining info endpoints omitted for brevity — see types.ts for full interface
	async candleSnapshot(p: any) { return HlSdk.infoClient.candleSnapshot(p); }
	async frontendOpenOrders(p: any) { return HlSdk.infoClient.frontendOpenOrders(p); }
	async fundingHistory(p: any) { return HlSdk.infoClient.fundingHistory(p); }
	async historicalOrders(p: any) { return HlSdk.infoClient.historicalOrders(p); }
	async l2Book(p: any) { return HlSdk.infoClient.l2Book(p); }
	async maxBuilderFee(p: any) { return HlSdk.infoClient.maxBuilderFee(p); }
	async metaAndAssetCtxs(p: any) { return HlSdk.infoClient.metaAndAssetCtxs(p); }
	async orderStatus(p: any) { return HlSdk.infoClient.orderStatus(p); }
	async spotMeta() { return HlSdk.infoClient.spotMeta(); }
	async spotMetaAndAssetCtxs() { return HlSdk.infoClient.spotMetaAndAssetCtxs(); }
	async userFees(p: any) { return HlSdk.infoClient.userFees(p); }
	async userFillsByTime(p: any) { return HlSdk.infoClient.userFillsByTime(p); }
	async userFunding(p: any) { return HlSdk.infoClient.userFunding(p); }
	async agentEnableDexAbstraction() { return this.exchangeClient.agentEnableDexAbstraction(); }
}
