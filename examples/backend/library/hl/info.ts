/**
 * HLInfo — Hyperliquid Info/Read Client
 *
 * Provides read-only access to Hyperliquid market data, account state,
 * and ledger queries. The getCCTPTransfers() method is critical for the
 * CCTP billing flow — it filters the user's ledger for CCTP bridge
 * transactions by looking for sends to the magic bridge address.
 *
 * The full HLInfo class has ~1485 lines covering market data, positions,
 * orders, fills, funding, and account state. Only the CCTP-relevant
 * portions are included here.
 */

import * as hl from "@nktkas/hyperliquid";
import type { Address } from "viem";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { HLInfoProvider } from "./types";
import { HlSdk } from "./providers/hlSdk";
import { Webshare } from "./providers/webshare";
import { Meter, metrics } from "@opentelemetry/api";

export class HLInfo {
	protected supabase: SupabaseClient;
	protected static meter: Meter = metrics.getMeter("hl");

	// Static info providers — shared across all HLInfo instances.
	// Uses the same Proxy-based fallback pattern as the exchange client.
	private static infoProviders: HLInfoProvider[] = [
		new HlSdk(),
		new Webshare(),
	];

	private static infoClient: HLInfoProvider = new Proxy(
		{} as HLInfoProvider,
		{
			get(_, prop: keyof HLInfoProvider) {
				return async (params: any) => {
					let lastError: unknown;
					for (const provider of HLInfo.infoProviders) {
						try {
							return await provider[prop](params);
						} catch (err) {
							if (err instanceof hl.ApiRequestError) throw err;
							if (
								err instanceof hl.HttpRequestError &&
								err.response?.status !== 429
							)
								throw err;
							lastError = err;
						}
					}
					throw lastError;
				};
			},
		},
	);

	constructor(supabase: SupabaseClient) {
		this.supabase = supabase;
	}

	// ========================================================================
	// Ledger Queries (CCTP-relevant)
	// ========================================================================

	/**
	 * Get all non-funding ledger updates for a user since a given timestamp.
	 * This includes deposits, withdrawals, CCTP transfers, and other
	 * non-trading balance changes.
	 */
	async getLedgerUpdates(
		user: Address,
		startTime: number,
	): Promise<hl.UserNonFundingLedgerUpdatesResponse> {
		HLInfo.meter.createCounter("hl.ledger-updates.call").add(1);
		const data = await HLInfo.infoClient.userNonFundingLedgerUpdates({
			user,
			startTime,
		});
		HLInfo.meter
			.createCounter("hl.api.weight")
			.add(20 + Math.floor(data.length / 20));
		return data;
	}

	/**
	 * Get CCTP transfers for a user.
	 *
	 * Filters the user's ledger updates for sends to the special CCTP
	 * bridge address: 0x2000000000000000000000000000000000000000
	 *
	 * On Hyperliquid, any 'send' to this address represents a CCTP
	 * cross-chain withdrawal. The delta contains:
	 * - token: "USDC"
	 * - amount: The USDC amount sent
	 * - nonce: Used for ordering and settlement verification
	 * - destination: Always 0x2000...0000 for CCTP
	 */
	async getCCTPTransfers(
		user: Address,
		startTime: number,
	): Promise<hl.UserNonFundingLedgerUpdatesResponse> {
		const ledgerUpdates = await this.getLedgerUpdates(user, startTime);
		return ledgerUpdates.filter(
			(update) =>
				update.delta.type === "send" &&
				update.delta.destination ===
					"0x2000000000000000000000000000000000000000",
		);
	}

	/**
	 * Get deposits (incoming transfers) for a user.
	 */
	async getDeposits(
		user: Address,
		startTime: number,
	): Promise<hl.UserNonFundingLedgerUpdatesResponse> {
		const ledgerUpdates = await this.getLedgerUpdates(user, startTime);
		return ledgerUpdates.filter(
			(update) =>
				update.delta.type === "deposit" ||
				(update.delta.type === "send" &&
					update.delta.destination !== user),
		);
	}

	/**
	 * Get withdrawals (outgoing transfers) for a user.
	 */
	async getWithdrawals(
		user: Address,
		startTime: number,
	): Promise<hl.UserNonFundingLedgerUpdatesResponse> {
		const ledgerUpdates = await this.getLedgerUpdates(user, startTime);
		return ledgerUpdates.filter(
			(update) =>
				update.delta.type === "withdraw" ||
				(update.delta.type === "send" &&
					update.delta.destination === user),
		);
	}

	// ========================================================================
	// Account State (used for balance checks before CCTP transfers)
	// ========================================================================

	/**
	 * Get the user's withdrawable balance (available for CCTP transfer).
	 */
	async getUserWithdrawable(
		user: Address,
		dex?: "perp" | "spot",
	): Promise<{ perp: number; spot: number }> {
		const state = await HLInfo.infoClient.clearinghouseState({ user });
		const perpWithdrawable = parseFloat(state.withdrawable);

		const spotState = await HLInfo.infoClient.spotClearinghouseState({
			user,
		});
		const spotWithdrawable = parseFloat(
			spotState.balances.find((b) => b.coin === "USDC")?.total ?? "0",
		);

		return {
			perp: perpWithdrawable,
			spot: spotWithdrawable,
		};
	}
}
