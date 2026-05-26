/**
 * Hyperliquid Provider Interfaces
 *
 * Defines the contract that both the official SDK provider (HlSdk) and
 * the fallback proxy provider (Webshare) must implement. The exchange
 * client uses these interfaces through a Proxy-based fallback pattern.
 */

import type * as hl from "@nktkas/hyperliquid";

/**
 * Info provider interface — read-only market data and account queries.
 * All methods map directly to Hyperliquid's Info API endpoints.
 */
export interface HLInfoProvider {
	allMids: (params: hl.AllMidsParameters) => Promise<hl.AllMidsResponse>;
	candleSnapshot: (
		params: hl.CandleSnapshotParameters,
	) => Promise<hl.CandleSnapshotResponse>;
	clearinghouseState: (
		params: hl.ClearinghouseStateParameters,
	) => Promise<hl.ClearinghouseStateResponse>;
	frontendOpenOrders: (
		params: hl.FrontendOpenOrdersParameters,
	) => Promise<hl.FrontendOpenOrdersResponse>;
	fundingHistory: (
		params: hl.FundingHistoryParameters,
	) => Promise<hl.FundingHistoryResponse>;
	historicalOrders: (
		params: hl.HistoricalOrdersParameters,
	) => Promise<hl.HistoricalOrdersResponse>;
	l2Book: (params: hl.L2BookParameters) => Promise<hl.L2BookResponse>;
	maxBuilderFee: (
		params: hl.MaxBuilderFeeParameters,
	) => Promise<hl.MaxBuilderFeeResponse>;
	metaAndAssetCtxs: (
		params: hl.MetaAndAssetCtxsParameters,
	) => Promise<hl.MetaAndAssetCtxsResponse>;
	orderStatus: (
		params: hl.OrderStatusParameters,
	) => Promise<hl.OrderStatusResponse>;
	spotClearinghouseState: (
		params: hl.SpotClearinghouseStateParameters,
	) => Promise<hl.SpotClearinghouseStateResponse>;
	spotMeta: () => Promise<hl.SpotMetaResponse>;
	spotMetaAndAssetCtxs: () => Promise<hl.SpotMetaAndAssetCtxsResponse>;
	userFees: (params: hl.UserFeesParameters) => Promise<hl.UserFeesResponse>;
	userFillsByTime: (
		params: hl.UserFillsByTimeParameters,
	) => Promise<hl.UserFillsByTimeResponse>;
	userFunding: (
		params: hl.UserFundingParameters,
	) => Promise<hl.UserFundingResponse>;
	/** Critical for CCTP: queries non-funding ledger updates (deposits, withdrawals, CCTP sends) */
	userNonFundingLedgerUpdates: (
		params: hl.UserNonFundingLedgerUpdatesParameters,
	) => Promise<hl.UserNonFundingLedgerUpdatesResponse>;
}

/**
 * Exchange provider interface — authenticated write operations.
 * Includes order placement, cancellation, leverage updates, and
 * the CCTP-critical sendToEvmWithData method.
 */
export interface HLExchangeProvider {
	approveBuilderFee: (
		params: hl.ApproveBuilderFeeParameters,
	) => Promise<hl.ApproveBuilderFeeSuccessResponse>;
	batchModify: (
		params: hl.BatchModifyParameters,
	) => Promise<hl.BatchModifySuccessResponse>;
	cancel: (
		params: hl.CancelParameters,
	) => Promise<hl.CancelSuccessResponse>;
	order: (
		params: hl.OrderParameters,
	) => Promise<hl.OrderSuccessResponse>;
	/** CCTP bridge: send USDC from Hyperliquid to any supported EVM chain */
	sendToEvmWithData: (
		params: hl.SendToEvmWithDataParameters,
	) => Promise<hl.SendToEvmWithDataSuccessResponse>;
	updateLeverage: (
		params: hl.UpdateLeverageParameters,
	) => Promise<hl.UpdateLeverageSuccessResponse>;
	usdClassTransfer: (
		params: hl.UsdClassTransferParameters,
	) => Promise<hl.UsdClassTransferSuccessResponse>;
	usdSend: (
		params: hl.UsdSendParameters,
	) => Promise<hl.UsdSendSuccessResponse>;
	withdraw3: (
		params: hl.Withdraw3Parameters,
	) => Promise<hl.Withdraw3SuccessResponse>;
}
