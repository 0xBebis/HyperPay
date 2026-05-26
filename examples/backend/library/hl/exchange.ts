/**
 * HLExchange — Hyperliquid Exchange Client Wrapper
 *
 * Provides authenticated exchange operations including CCTP cross-chain
 * transfers via sendToEvmWithData(). Uses a Proxy-based provider fallback
 * pattern: tries the official HL SDK first, falls back to a proxy provider
 * on HTTP 429 rate limits. API rejections are NOT retried.
 *
 * For the CCTP billing flow, only sendToEvmWithData() is used. The full
 * exchange client also handles order placement, cancellation, leverage
 * updates, and withdrawals — omitted here for brevity.
 */

import * as hl from "@nktkas/hyperliquid";
import { type Address } from "viem";
import { ethers } from "ethers";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { HLInfo } from "./info";
import type { HLExchangeProvider } from "./types";
import { HlSdk } from "./providers/hlSdk";
import { Webshare } from "./providers/webshare";

export class HLExchange extends HLInfo {
	private exchangeClient: HLExchangeProvider;
	private moonAccountAddress: Address;

	constructor(
		accountAddress: Address,
		supabase: SupabaseClient,
		private user: User,
		private token: string,
	) {
		super(supabase);
		this.moonAccountAddress = ethers.getAddress(accountAddress) as Address;
	}

	/**
	 * Initialize the exchange client with the user's Moon wallet.
	 * Creates a MoonAccount (custodial wallet) and sets up the provider
	 * fallback chain: HlSdk → Webshare.
	 */
	async initialize(): Promise<void> {
		const { account: moonAccount, init } = createMoonAccount({
			accountAddress: this.moonAccountAddress,
			supabase: this.supabase,
			user: this.user,
			token: this.token,
			chainId: "42161",
		});
		await init();

		this.exchangeClient = this.createExchangeProvider([
			new HlSdk(moonAccount),
			new Webshare(moonAccount),
		]);
	}

	/**
	 * Create a provider with automatic fallback on rate limits.
	 *
	 * Uses a Proxy to intercept all method calls. For each call, it tries
	 * providers in order. Only HTTP 429 errors trigger fallback to the next
	 * provider — all other errors (API rejections, validation failures) are
	 * thrown immediately to prevent masking real errors.
	 */
	createExchangeProvider(providers: HLExchangeProvider[]): HLExchangeProvider {
		return new Proxy({} as HLExchangeProvider, {
			get(_, prop: keyof HLExchangeProvider) {
				return async (params: any) => {
					let lastError: unknown;

					for (const provider of providers) {
						try {
							return await provider[prop](params);
						} catch (err) {
							if (err instanceof hl.ApiRequestError) {
								// Do not retry invalid requests rejected by the API
								throw err;
							}
							if (err instanceof hl.HttpRequestError) {
								if (err.response && err.response.status !== 429) {
									// Only retry rate limit errors
									throw err;
								}
							} else if (err instanceof hl.HyperliquidError) {
								throw err;
							}
							lastError = err;
						}
					}

					throw lastError;
				};
			},
		});
	}

	// ========================================================================
	// CCTP Bridge Method
	// ========================================================================

	/**
	 * Send USDC from Hyperliquid to an EVM chain via Circle CCTP.
	 *
	 * This is the core CCTP method used by the billing controller. Parameters:
	 * - token: "USDC"
	 * - amount: USDC amount as string
	 * - destinationRecipient: The recipient address on the destination chain
	 * - destinationChainId: CCTP domain ID (6 = Base, 26 = Arc)
	 * - data: "0x" enables automatic forwarding (no gas needed on destination)
	 * - gasLimit: Gas limit for the destination chain transaction
	 *
	 * Under the hood, Hyperliquid burns USDC on HyperEVM, Circle's attestation
	 * service signs the burn message, and USDC is minted on the destination chain.
	 */
	async sendToEvmWithData(
		data: hl.SendToEvmWithDataParameters,
	): Promise<hl.SendToEvmWithDataSuccessResponse> {
		return await this.exchangeClient.sendToEvmWithData(data);
	}
}

// Note: createMoonAccount is imported from the platform's wallet abstraction
// layer. It creates an authenticated account object that can sign transactions
// on behalf of the user via the Moon SDK custodial wallet infrastructure.
declare function createMoonAccount(params: {
	accountAddress: Address;
	supabase: SupabaseClient;
	user: User;
	token: string;
	chainId: string;
}): { account: any; init: () => Promise<void> };
