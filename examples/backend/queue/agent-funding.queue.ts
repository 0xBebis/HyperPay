/**
 * Agent Funding Queue (Legacy Reference)
 * ----------------------------------------
 * NOTE: This is the pre-extraction production implementation included for
 * reference. It uses Li.Fi for bridging and ETH→USDC swaps. The extracted
 * CCTP-native version is in packages/funding-pipeline/ which replaces Li.Fi
 * with Circle CCTP and eliminates the swap step entirely.
 *
 * Original description:
 * Multi-step pipeline that fully funds an agent for trading on Hyperliquid
 * after the user has triggered the upstream payment (OnRamper, wallet ETH
 * transfer, or wallet USDC transfer).
 *
 * State machine:
 *   waiting_deposit  → poll agent wallet for ETH/USDC arrival
 *   swapping         → Odos ETH→USDC (reserve gas, only when input is ETH)
 *   buying_credits   → ERC20 transfer of $25 USDC → CREDITS_COLLECTION_WALLET
 *   confirming_credits → wait for tx receipt + dual-balance verification
 *   granting_credits → call add_credits RPC + insert billing_transactions audit
 *   depositing_hl    → HLController.deposit() for remaining USDC
 *   complete         → terminal success
 *   failed           → terminal failure
 *
 * Persistence:
 *   Every state transition updates the `agent_funding_jobs` row in supabase
 *   so the queue can be retried/resumed and the frontend can rehydrate after
 *   a page refresh.
 *
 * Live updates:
 *   On every transition, emits a signed pubsub event on the channel
 *   `funding.update.${jobId}` so the frontend can listen via the existing
 *   SocketProvider for live progress without polling.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Job } from "bullmq";
import {
	createPublicClient,
	formatUnits,
	getAddress,
	http,
	parseUnits,
} from "viem";
import { arbitrum } from "viem/chains";
import winston from "winston";
import { createLogger } from "winston";
import config from "../../config";
import { AccountController } from "../../controller/account.Controller";
import { ERC20Controller } from "../../controller/erc20.Controller";
import { HLController } from "../../controller/hl.Controller";
import { LifiController } from "../../controller/lifi.Controller";
import { Lifi } from "../../library/lifi";
import { EventValidator } from "../../library/pubsub/event-validator";
import VaultPubSub from "../../library/pubsub/pubsub";
import { generateToken } from "../../routes/auth.router";

// ============================================================================
// Constants
// ============================================================================

const ARBITRUM_CHAIN_ID = "42161";
const ARBITRUM_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
/** Team collection wallet — receives the $25 USDC for credit purchases. */
const CREDITS_COLLECTION_WALLET =
	"0x87f1d896e39f0629c7a391d255364ed9C4a47Da0";

/** USDC amount sent to the collection wallet when buying credits. */
const CREDITS_USDC_COST = 25;
/** Credits granted in exchange for the $25 USDC. */
const CREDITS_AMOUNT = 2500;
/** Threshold below which the credits offer is allowed. */
const CREDITS_OFFER_THRESHOLD = 1000;

/**
 * ETH reserved for gas (won't be swapped). The Li.Fi swap tx routes through
 * a DEX aggregator (Odos / 1inch / etc.) and is gas-heavy (~200-400k gas),
 * so we need more than a simple transfer would require. 0.002 ETH ≈ $3-4 at
 * current prices — safe margin for swap + HL deposit.
 */
const ETH_GAS_RESERVE = parseUnits("0.002", 18);

/** Polling interval for ETH deposit detection (ms). */
const DEPOSIT_POLL_INTERVAL_MS = 5_000;
/** Maximum time to wait for the ETH deposit to arrive (ms). */
const DEPOSIT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Fraction of the user-committed `amount_usd` that must be received before the
 * pipeline advances past `waiting_deposit`. Set to 0.8 so the user can lose up
 * to 20% to fees/slippage/short-fills without the pipeline either:
 *   • running with an obviously-underfunded balance (e.g. user promised $100,
 *     sent $5, pipeline tries to swap and fails halfway), or
 *   • triggering on incidental dust (the prior tripwire was 1 µETH — any
 *     gas refund or unrelated transfer would count as "the deposit").
 * Also naturally handles multi-tx deposits: we keep polling until the
 * cumulative balance crosses the threshold.
 */
const FUNDING_TARGET_FRACTION = 0.8;

/**
 * Last-resort ETH/USD price used only if both HL and CoinGecko fail. Picked
 * deliberately LOW so an outage makes the threshold STRICTER (more ETH
 * required) — erring toward "user funded less than expected" rather than
 * "pipeline ran on dust".
 */
const ETH_PRICE_FALLBACK_USD = 2_000;

// ─── Multi-chain bridge support ─────────────────────────────────────────────

/**
 * Source chains we accept deposits on. The agent wallet address is identical
 * across all EVM chains, so the user can send ETH to any of these and we'll
 * detect it. Non-Arbitrum chains trigger the `bridging` step via Li.Fi.
 *
 * Polygon is intentionally excluded: its native gas token is MATIC, so a
 * WETH deposit there can't pay the gas required to broadcast the bridge.
 * Re-enable when we add a sponsored-tx / gas-relay path.
 *
 * Balance reads go through `AccountController.getBalance(addr, token, chainId)`
 * (not viem) so this list only needs to carry the EVM chain id, a label, and
 * the per-chain gas reserve — no viem `Chain` object required.
 */
const SUPPORTED_SOURCE_CHAINS: Array<{
	id: string;
	label: string;
	/** ETH reserved for gas on the source chain (in wei). L1 needs more. */
	gasReserveWei: bigint;
}> = [
	{ id: "1", label: "Ethereum", gasReserveWei: parseUnits("0.005", 18) },
	{ id: "10", label: "Optimism", gasReserveWei: parseUnits("0.0005", 18) },
	{ id: "8453", label: "Base", gasReserveWei: parseUnits("0.0005", 18) },
	{ id: "42161", label: "Arbitrum", gasReserveWei: ETH_GAS_RESERVE },
];

/** Native ETH placeholder address used by Li.Fi (and Odos) for non-ERC20. */
const NATIVE_ETH_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Poll interval for Li.Fi bridge status (ms). */
const BRIDGE_STATUS_POLL_INTERVAL_MS = 10_000;
/** Max time to wait for a bridge to complete. */
const BRIDGE_TIMEOUT_MS = 30 * 60 * 1000;

/** Polling interval for tx receipt confirmation (ms). */
const RECEIPT_POLL_INTERVAL_MS = 3_000;
/** Maximum time to wait for a tx receipt (ms). */
const RECEIPT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** Tolerance for the agent USDC balance drop check (in USDC, accounts for gas dust).
 *  Scaled to match the test CREDITS_USDC_COST of 2.5 — tighten/loosen if either changes. */
const USDC_BALANCE_TOLERANCE = 0.05;

// ============================================================================
// Types
// ============================================================================

export type FundingState =
	| "waiting_deposit"
	| "bridging"
	| "swapping"
	| "buying_credits"
	| "confirming_credits"
	| "granting_credits"
	| "depositing_hl"
	| "complete"
	| "failed"
	| "cancelled";

/**
 * Outcome of `stepWaitForDeposit`. `chainId` tells the main processor whether
 * the next step is `bridging` (chainId !== "42161") or `swapping` (Arbitrum).
 * `ethWei` is the source-chain ETH amount detected (0n when the user paid
 * directly in USDC on Arbitrum — the wallet pre-check fired).
 */
export interface DepositDetection {
	chainId: string;
	ethWei: bigint;
}

export interface AgentFundingJobData {
	jobId: string;
	userId: string;
	agentId: string;
	agentWallet: string;
	amountUsd: number;
	buyCredits: boolean;
	fundingMethod: "onramper" | "wallet-eth" | "wallet-usdc";
}

export interface SignedAgentFundingJob {
	data: AgentFundingJobData;
	signature: string;
	timestamp: number;
}

interface FundingContext {
	job: Job<SignedAgentFundingJob>;
	jobData: AgentFundingJobData;
	logger: winston.Logger;
	pubsub: VaultPubSub;
	supabase: SupabaseClient;
	serviceClient: SupabaseClient;
	req: any;
	channel: string;
	/**
	 * Arbitrum public client. Retained for ERC20 (USDC) `readContract` calls —
	 * AccountController only exposes native ETH balance, so we still need viem
	 * for token reads. Do NOT use this for native ETH balance lookups; route
	 * those through `accountController.getBalance(...)` instead so the Moon SDK
	 * stays the single source of truth for wallet state.
	 */
	publicClient: ReturnType<typeof createPublicClient>;
	/**
	 * Cached, request-bound AccountController for native ETH balance reads on
	 * any chain. Instantiated once per job (cheap — just sets `this.request`)
	 * and reused for every poll in `readAllChainBalances` + the Arbitrum
	 * pre-swap balance check.
	 */
	accountController: AccountController;
}

// ============================================================================
// Helpers
// ============================================================================

const validator = new EventValidator();

const workerLogger = createLogger({
	level: "info",
	defaultMeta: { service: "agent-funding-queue" },
	transports: [new winston.transports.Console()],
});

/**
 * Build the pubsub channel name for a given funding job.
 *
 * The channel embeds the userId so the socket-server channel auth (which
 * requires at least one UUID in the channel name to match the authenticated
 * user) lets the owner subscribe. Without the userId in the path the only
 * UUID would be the agent_id, which never matches the user, and every
 * subscription would be denied.
 */
export function getFundingJobChannel(jobId: string, userId: string): string {
	return `funding.update.${userId}.${jobId}`;
}

/**
 * Error class that wraps any underlying step failure with the name of the
 * step that triggered it. Lets the top-level catch produce a meaningful
 * error string in the DB so the frontend (and operators reading the row)
 * know exactly which stage of the pipeline failed.
 */
class FundingStepError extends Error {
	step: string;
	cause?: any;
	constructor(step: string, message: string, cause?: any) {
		super(message);
		this.name = "FundingStepError";
		this.step = step;
		this.cause = cause;
	}
}

/**
 * Sentinel error thrown when a worker detects that its DB row has been
 * marked `cancelled` (by /start superseding it or by an explicit /cancel).
 * The top-level catch handles this specially: it returns success-of-sorts
 * to BullMQ so the job is NOT retried, and skips `failJob` since the row
 * is already in the correct terminal state.
 */
class JobCancelledError extends Error {
	constructor(jobId: string) {
		super(`Funding job ${jobId} cancelled mid-flight`);
		this.name = "JobCancelledError";
	}
}

/**
 * Stringify an error from any source (Odos controller, viem, ethers, raw
 * Error) into a single multi-line string that captures everything we need
 * to debug the failure. Without this, errors like "Invalid JSON response"
 * end up in the DB with zero context about which call originated them.
 */
function formatStepError(err: any): string {
	const parts: string[] = [];
	if (err?.message) parts.push(err.message);
	if (err?.shortMessage && err.shortMessage !== err?.message) {
		parts.push(`short=${err.shortMessage}`);
	}
	if (err?.code) parts.push(`code=${err.code}`);
	if (err?.status || err?.statusCode) {
		parts.push(`status=${err.status ?? err.statusCode}`);
	}
	if (err?.response?.data) {
		try {
			parts.push(
				`response=${JSON.stringify(err.response.data).slice(0, 800)}`,
			);
		} catch {
			parts.push(`response=${String(err.response.data).slice(0, 800)}`);
		}
	}
	if (err?.cause?.message && err.cause.message !== err.message) {
		parts.push(`cause=${err.cause.message}`);
	}
	if (parts.length === 0) {
		try {
			parts.push(JSON.stringify(err).slice(0, 800));
		} catch {
			parts.push(String(err));
		}
	}
	return parts.join(" | ");
}

/**
 * Run a single pipeline step with structured error wrapping. Any thrown
 * error is rethrown as a FundingStepError tagged with the step name so the
 * top-level catch can persist a useful error message + stack snippet.
 */
async function runStep<T>(
	ctx: FundingContext,
	step: FundingState | "init",
	fn: () => Promise<T>,
): Promise<T> {
	const startedAt = Date.now();
	ctx.logger.info(
		`[funding] ▶ STEP START "${step}" — job=${ctx.jobData.jobId} agent=${ctx.jobData.agentId}`,
	);
	try {
		const result = await fn();
		ctx.logger.info(
			`[funding] ✓ STEP DONE  "${step}" (${Date.now() - startedAt}ms) — job=${ctx.jobData.jobId}`,
		);
		return result;
	} catch (err: any) {
		// If it's already a FundingStepError, preserve the inner step name
		if (err instanceof FundingStepError) {
			ctx.logger.error(
				`[funding] ✗ STEP FAIL  "${step}" (${Date.now() - startedAt}ms) — already-wrapped: ${err.message}`,
			);
			throw err;
		}
		const formatted = formatStepError(err);
		ctx.logger.error(
			`[funding] ✗ STEP FAIL  "${step}" (${Date.now() - startedAt}ms) — job=${ctx.jobData.jobId}: ${formatted}`,
			{ stack: err?.stack },
		);
		throw new FundingStepError(step, formatted, err);
	}
}

/**
 * Load the current persisted state of the funding job. Used at the top of
 * every step so retries can skip work that already completed (idempotency).
 */
async function loadJobRow(ctx: FundingContext): Promise<any | null> {
	const { data } = await ctx.serviceClient
		.from("agent_funding_jobs")
		.select("*")
		.eq("job_id", ctx.jobData.jobId)
		.maybeSingle();
	return data;
}

/**
 * Throw `JobCancelledError` if the DB row has been marked `cancelled`.
 * Called inside the long-running `waiting_deposit` polling loop and once at
 * the top of `processFundingJob` so a supersession (new /start) or explicit
 * /cancel takes effect promptly without waiting for the deposit timeout.
 */
async function assertNotCancelled(ctx: FundingContext): Promise<void> {
	const row = await loadJobRow(ctx);
	if (row?.state === "cancelled") {
		throw new JobCancelledError(ctx.jobData.jobId);
	}
}

/**
 * Persist a state update to the agent_funding_jobs row AND emit a live
 * pubsub event on the funding job channel. Single source of truth for
 * progress so the DB and the live socket stream never drift.
 */
async function publishUpdate(
	ctx: FundingContext,
	state: FundingState,
	progress: number,
	patch: Record<string, any> = {},
	message?: string,
): Promise<void> {
	const update = {
		state,
		progress,
		message: message ?? null,
		updated_at: new Date().toISOString(),
		...patch,
	};

	// Persist to DB (idempotent — same row, just an update)
	const { error } = await ctx.serviceClient
		.from("agent_funding_jobs")
		.update(update)
		.eq("job_id", ctx.jobData.jobId);

	if (error) {
		ctx.logger.error(
			`[funding] Failed to persist state update for job ${ctx.jobData.jobId}: ${error.message}`,
		);
	}

	// Update BullMQ progress
	try {
		await ctx.job.updateProgress(progress);
	} catch (err) {
		ctx.logger.warn(`[funding] updateProgress failed: ${err}`);
	}

	// Live pubsub event
	ctx.pubsub.emit(ctx.channel, {
		jobId: ctx.jobData.jobId,
		state,
		progress,
		message,
		txHashes: {
			deposit: patch.deposit_tx_hash,
			swap: patch.swap_tx_hash,
			credits: patch.credits_tx_hash,
			hlDeposit: patch.hl_deposit_tx_hash,
		},
	});
}

/**
 * Mark the job as failed with structured error info and emit a final update.
 * The error string in the DB carries enough context (step + message + stack
 * snippet) for an operator to diagnose without digging through worker logs,
 * and the frontend just renders the whole multi-line string.
 */
async function failJob(
	ctx: FundingContext,
	err: any,
	step: FundingState | "init" | null,
	patch: Record<string, any> = {},
): Promise<void> {
	const stepName =
		err instanceof FundingStepError ? err.step : (step ?? "unknown");
	const message =
		err instanceof FundingStepError
			? err.message
			: typeof err === "string"
				? err
				: formatStepError(err);
	const stack: string | undefined =
		err?.stack ?? err?.cause?.stack ?? undefined;

	const composedError = [
		`[step=${stepName}] ${message}`,
		stack ? `\nstack: ${String(stack).slice(0, 2000)}` : "",
	]
		.join("")
		.slice(0, 4000);

	ctx.logger.error(
		`[funding] Job ${ctx.jobData.jobId} failed at step "${stepName}": ${message}`,
		{ stack },
	);

	await publishUpdate(
		ctx,
		"failed",
		0,
		{
			...patch,
			error: composedError,
			completed_at: new Date().toISOString(),
		},
		`Failed at ${stepName}`,
	);
}

/**
 * Fetch ETH/USD spot price for sizing the funding threshold. Order of attempts:
 *   1. Hyperliquid `allMids` — we already deposit to HL, so this is the most
 *      authoritative price for our use case and is cheap/fast/free.
 *   2. CoinGecko `simple/price` — public fallback.
 *   3. `ETH_PRICE_FALLBACK_USD` — conservative low fallback (strictens the
 *      threshold rather than loosens it).
 *
 * 5s timeout per source so a slow API can't extend the funding wait visibly.
 */
async function fetchEthUsdPrice(logger: winston.Logger): Promise<number> {
	try {
		const res = await fetch("https://api.hyperliquid.xyz/info", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ type: "allMids" }),
			signal: AbortSignal.timeout(5000),
		});
		if (res.ok) {
			const data = (await res.json()) as Record<string, string>;
			const price = data?.ETH ? parseFloat(data.ETH) : NaN;
			if (Number.isFinite(price) && price > 0) {
				logger.info(`[funding] ETH price from HL: $${price.toFixed(2)}`);
				return price;
			}
		}
	} catch (err) {
		logger.warn(
			`[funding] HL ETH price fetch failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	try {
		const res = await fetch(
			"https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
			{ signal: AbortSignal.timeout(5000) },
		);
		if (res.ok) {
			const data = (await res.json()) as { ethereum?: { usd?: number } };
			const price = data?.ethereum?.usd;
			if (typeof price === "number" && price > 0) {
				logger.info(`[funding] ETH price from CoinGecko: $${price.toFixed(2)}`);
				return price;
			}
		}
	} catch (err) {
		logger.warn(
			`[funding] CoinGecko ETH price fetch failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	logger.warn(
		`[funding] Could not fetch ETH price from any source — using conservative fallback $${ETH_PRICE_FALLBACK_USD}`,
	);
	return ETH_PRICE_FALLBACK_USD;
}

/**
 * Convert a USD target to wei using the supplied ETH/USD price. Rounded to
 * the precision parseUnits accepts; tiny rounding losses are immaterial at
 * a 20% threshold buffer.
 */
function targetEthWeiFromUsd(targetUsd: number, ethUsdPrice: number): bigint {
	const ethTarget = (targetUsd / ethUsdPrice).toFixed(18);
	return parseUnits(ethTarget, 18);
}

/**
 * Read the USDC balance of any address on Arbitrum (read-only, no auth needed).
 * Returns the human-readable USDC amount as a number.
 */
async function readUsdcBalance(
	publicClient: ReturnType<typeof createPublicClient>,
	address: string,
): Promise<number> {
	const raw = await publicClient.readContract({
		address: ARBITRUM_USDC as `0x${string}`,
		abi: [
			{
				name: "balanceOf",
				type: "function",
				stateMutability: "view",
				inputs: [{ name: "account", type: "address" }],
				outputs: [{ name: "", type: "uint256" }],
			},
		],
		functionName: "balanceOf",
		args: [getAddress(address) as `0x${string}`],
	});
	return parseFloat(formatUnits(raw as bigint, 6));
}

/**
 * Wait for a transaction receipt with a timeout. Returns the receipt or
 * throws if it doesn't confirm in time or if the tx reverted.
 */
async function waitForReceipt(
	publicClient: ReturnType<typeof createPublicClient>,
	txHash: string,
	logger: winston.Logger,
): Promise<{ status: "success" | "reverted" }> {
	const start = Date.now();
	while (Date.now() - start < RECEIPT_TIMEOUT_MS) {
		try {
			const receipt = await publicClient.getTransactionReceipt({
				hash: txHash as `0x${string}`,
			});
			if (receipt) {
				return { status: receipt.status };
			}
		} catch {
			// Receipt not available yet — keep polling
		}
		await new Promise((resolve) => setTimeout(resolve, RECEIPT_POLL_INTERVAL_MS));
	}
	throw new Error(
		`Tx receipt timeout after ${RECEIPT_TIMEOUT_MS / 1000}s for ${txHash}`,
	);
}

// ============================================================================
// Step: waitForDeposit
// ============================================================================

/**
 * Polls the agent wallet's ETH balance on Arbitrum until a deposit is detected.
 * Captures the initial balance on first read so concurrent dust doesn't
 * confuse the detection. Returns the deposited amount in wei.
 */
async function stepWaitForDeposit(
	ctx: FundingContext,
	existing?: any,
): Promise<DepositDetection> {
	// Idempotency: if a previous run already detected the deposit, reuse it.
	if (existing?.received_eth_amount && Number(existing.received_eth_amount) > 0) {
		const wei = parseUnits(String(existing.received_eth_amount), 18);
		const chainId: string = existing.source_chain_id ?? "42161";
		ctx.logger.info(
			`[funding] Skipping deposit wait — already detected ${existing.received_eth_amount} ETH on chain ${chainId}`,
		);
		return { chainId, ethWei: wei };
	}

	// Funding threshold — wait until total wallet value (ETH × price + USDC)
	// reaches 80% of the amount the user committed to. Prevents three
	// failure modes:
	//   1. User promises $100 but sends $5 — pipeline would otherwise try to
	//      swap dust and fail mid-flight.
	//   2. Multi-tx deposits (user sends $30, then $70) — first tx used to
	//      trigger detection instantly, pipeline ran with only $30 and the
	//      $70 follow-up was orphaned in the wallet.
	//   3. Random dust transfers — the old 1 µETH tripwire would trigger on
	//      any incidental tx.
	const targetUsd = ctx.jobData.amountUsd * FUNDING_TARGET_FRACTION;
	const ethUsdPrice = await fetchEthUsdPrice(ctx.logger);
	const targetEthWei = targetEthWeiFromUsd(targetUsd, ethUsdPrice);
	ctx.logger.info(
		`[funding] Funding gate: need ≥ $${targetUsd.toFixed(2)} ` +
			`(≈ ${formatUnits(targetEthWei, 18)} ETH @ $${ethUsdPrice.toFixed(2)}) ` +
			`out of $${ctx.jobData.amountUsd.toFixed(2)} committed`,
	);

	// USDC pre-check: if the wallet already has enough USDC on Arbitrum to
	// cover the threshold, skip ETH watching entirely. Bridging is also
	// unnecessary — the USDC is already on the destination chain.
	const existingUsdcOnEntry = await readUsdcBalance(
		ctx.publicClient,
		ctx.jobData.agentWallet,
	);
	if (existingUsdcOnEntry >= targetUsd) {
		ctx.logger.info(
			`[funding] Wallet already has ${existingUsdcOnEntry.toFixed(4)} USDC on Arbitrum (≥$${targetUsd.toFixed(2)}) — skipping ETH deposit wait`,
		);
		await publishUpdate(
			ctx,
			"waiting_deposit",
			15,
			{ received_eth_amount: 0, source_chain_id: "42161" },
			`Found $${existingUsdcOnEntry.toFixed(2)} USDC in wallet`,
		);
		return { chainId: "42161", ethWei: 0n };
	}

	await publishUpdate(
		ctx,
		"waiting_deposit",
		5,
		{},
		`Waiting for $${ctx.jobData.amountUsd.toFixed(0)} of ETH on ${SUPPORTED_SOURCE_CHAINS.map((c) => c.label).join(", ")}...`,
	);

	// ── Per-chain initial-balance snapshot ──────────────────────────────────
	// We snapshot each chain's starting ETH balance so the polling loop can
	// compute per-chain deltas. Reused across retries via DB persistence.
	let initialByChain: Record<string, bigint>;
	if (existing?.initial_balances_by_chain) {
		initialByChain = parseInitialBalances(existing.initial_balances_by_chain);
	} else {
		const snapshot = await readAllChainBalances(ctx);
		initialByChain = Object.fromEntries(
			snapshot.map((s) => [s.chainId, s.balance]),
		);

		// Pre-arrival guard: if the combined cross-chain value already meets
		// the target, the user pre-funded before the job picked up. Accept
		// the chain with the most ETH as the source and proceed. We don't
		// snapshot in that case — `received_eth_amount` carries the value.
		const preArrival = detectPreArrival(snapshot, ethUsdPrice, existingUsdcOnEntry, targetUsd);
		if (preArrival) {
			ctx.logger.info(
				`[funding] Pre-arrived deposit on chain ${preArrival.chainId} (${preArrival.label}): ${formatUnits(preArrival.balance, 18)} ETH ≈ $${preArrival.usdValue.toFixed(2)}`,
			);
			await ctx.serviceClient
				.from("agent_funding_jobs")
				.update({
					initial_balances_by_chain: zeroedBalancesJson(),
					source_chain_id: preArrival.chainId,
					received_eth_amount: parseFloat(
						formatUnits(preArrival.balance, 18),
					),
				})
				.eq("job_id", ctx.jobData.jobId);
			await publishUpdate(
				ctx,
				"waiting_deposit",
				15,
				{
					received_eth_amount: parseFloat(
						formatUnits(preArrival.balance, 18),
					),
					source_chain_id: preArrival.chainId,
				},
				`Found ${parseFloat(formatUnits(preArrival.balance, 18)).toFixed(6)} ETH on ${preArrival.label}`,
			);
			return { chainId: preArrival.chainId, ethWei: preArrival.balance };
		}

		await ctx.serviceClient
			.from("agent_funding_jobs")
			.update({
				initial_balances_by_chain: serializeBalances(initialByChain),
			})
			.eq("job_id", ctx.jobData.jobId);
	}

	// Track the last partial-fill USD we emitted so the polling loop only
	// publishes a new "received $X, send $Y more" message when the user has
	// made noticeable progress — avoids flooding the socket with every poll.
	let lastPartialPublishedUsd = 0;
	const PARTIAL_PUBLISH_THRESHOLD_USD = 1;

	const start = Date.now();
	while (Date.now() - start < DEPOSIT_TIMEOUT_MS) {
		// Cancellation check — if /start was called again for this agent (or
		// /cancel was invoked) the row is marked `cancelled` and we exit
		// immediately so the superseded job never runs the swap/deposit pipeline.
		await assertNotCancelled(ctx);

		// Read balances across every chain + USDC on Arbitrum in parallel.
		const [snapshot, currentUsdc] = await Promise.all([
			readAllChainBalances(ctx),
			readUsdcBalance(ctx.publicClient, ctx.jobData.agentWallet),
		]);

		// Per-chain delta in USD. The chain with the largest delta is the
		// candidate source. USDC adds to the total but isn't tied to any
		// source chain — it lives on Arbitrum.
		let bestChain: { chainId: string; label: string; delta: bigint; deltaUsd: number } | null = null;
		let totalDeltaUsd = 0;
		for (const s of snapshot) {
			const init = initialByChain[s.chainId] ?? 0n;
			const delta = s.balance - init;
			if (delta <= 0n) continue;
			const deltaUsd = parseFloat(formatUnits(delta, 18)) * ethUsdPrice;
			totalDeltaUsd += deltaUsd;
			if (!bestChain || delta > bestChain.delta) {
				bestChain = { chainId: s.chainId, label: s.label, delta, deltaUsd };
			}
		}
		const valueUsd = totalDeltaUsd + currentUsdc;

		// Threshold met — favor Arbitrum if a deposit arrived there at all,
		// even if another chain has more (no bridge → simpler/cheaper).
		const arbDelta = snapshot.find((s) => s.chainId === "42161");
		const arbInit = initialByChain["42161"] ?? 0n;
		const arbDeltaWei = arbDelta ? arbDelta.balance - arbInit : 0n;
		const arbDeltaUsd =
			parseFloat(formatUnits(arbDeltaWei > 0n ? arbDeltaWei : 0n, 18)) *
				ethUsdPrice +
			currentUsdc;

		if (arbDeltaUsd >= targetUsd) {
			ctx.logger.info(
				`[funding] Threshold met on Arbitrum directly: $${arbDeltaUsd.toFixed(2)} ≥ $${targetUsd.toFixed(2)} (no bridge needed)`,
			);
			await publishUpdate(
				ctx,
				"waiting_deposit",
				15,
				{
					received_eth_amount: parseFloat(formatUnits(arbDeltaWei, 18)),
					source_chain_id: "42161",
				},
				`Received $${arbDeltaUsd.toFixed(2)} on Arbitrum`,
			);
			return { chainId: "42161", ethWei: arbDeltaWei };
		}
		if (valueUsd >= targetUsd && bestChain) {
			ctx.logger.info(
				`[funding] Threshold met across chains: $${valueUsd.toFixed(2)} ≥ $${targetUsd.toFixed(2)} ` +
					`— best source: ${bestChain.label} (${formatUnits(bestChain.delta, 18)} ETH ≈ $${bestChain.deltaUsd.toFixed(2)})`,
			);
			await publishUpdate(
				ctx,
				"waiting_deposit",
				15,
				{
					received_eth_amount: parseFloat(formatUnits(bestChain.delta, 18)),
					source_chain_id: bestChain.chainId,
				},
				`Received $${valueUsd.toFixed(2)} (bridging from ${bestChain.label})`,
			);
			return { chainId: bestChain.chainId, ethWei: bestChain.delta };
		}

		// Partial-fill status — only publish when ≥$1 more has landed since
		// the last emit, so we don't spam the socket every 5s.
		if (
			valueUsd > 0 &&
			valueUsd - lastPartialPublishedUsd >= PARTIAL_PUBLISH_THRESHOLD_USD
		) {
			const remainingUsd = Math.max(0, ctx.jobData.amountUsd - valueUsd);
			const pct = Math.min(99, Math.floor((valueUsd / targetUsd) * 100));
			const progressVal = 5 + Math.floor(pct * 0.1);
			const sourcePart = bestChain
				? ` on ${bestChain.label}`
				: "";
			await publishUpdate(
				ctx,
				"waiting_deposit",
				progressVal,
				{},
				`Received $${valueUsd.toFixed(2)} of ETH${sourcePart} — please send $${remainingUsd.toFixed(2)} more to complete funding`,
			);
			lastPartialPublishedUsd = valueUsd;
		}

		await new Promise((resolve) =>
			setTimeout(resolve, DEPOSIT_POLL_INTERVAL_MS),
		);
	}

	throw new Error(
		`Deposit timeout after ${DEPOSIT_TIMEOUT_MS / 60000} minutes — needed at least $${targetUsd.toFixed(2)} across all supported chains`,
	);
}

// ─── Multi-chain helpers ────────────────────────────────────────────────────

/**
 * Read native ETH balance on every supported source chain in parallel via
 * `AccountController.getBalance`. Going through the controller (instead of a
 * per-chain viem `PublicClient`) keeps RPC routing/retries/auth centralized
 * in the Moon SDK rather than duplicated here in the queue.
 */
async function readAllChainBalances(ctx: FundingContext): Promise<
	Array<{ chainId: string; label: string; balance: bigint }>
> {
	const checksummed = getAddress(ctx.jobData.agentWallet);
	const token = ctx.req.headers.authorization;
	return Promise.all(
		SUPPORTED_SOURCE_CHAINS.map(async (c) => {
			try {
				const res = await ctx.accountController.getBalance(
					checksummed,
					token,
					c.id,
				);
				const raw = res?.data?.balance ?? "0";
				return { chainId: c.id, label: c.label, balance: BigInt(raw) };
			} catch (err) {
				ctx.logger.warn(
					`[funding] Failed to read balance on ${c.label} (${c.id}): ${err instanceof Error ? err.message : String(err)}`,
				);
				return { chainId: c.id, label: c.label, balance: 0n };
			}
		}),
	);
}

/**
 * Deserialize the JSONB initial-balances column back into bigint wei. Stored
 * as decimal strings (e.g. "0.005") so the column is human-readable.
 */
function parseInitialBalances(json: any): Record<string, bigint> {
	const out: Record<string, bigint> = {};
	if (!json || typeof json !== "object") return out;
	for (const [chainId, val] of Object.entries(json)) {
		try {
			out[chainId] = parseUnits(String(val), 18);
		} catch {
			out[chainId] = 0n;
		}
	}
	return out;
}

/** Serialize for DB persistence (inverse of parseInitialBalances). */
function serializeBalances(byChain: Record<string, bigint>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [chainId, wei] of Object.entries(byChain)) {
		out[chainId] = formatUnits(wei, 18);
	}
	return out;
}

/** Zeroed snapshot used when the deposit pre-arrived (no real baseline). */
function zeroedBalancesJson(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const c of SUPPORTED_SOURCE_CHAINS) out[c.id] = "0";
	return out;
}

/**
 * If the user pre-funded a chain before this job started, no delta will be
 * detectable in the polling loop. Returns the chain with the most ETH if the
 * combined wallet value already meets the target.
 */
function detectPreArrival(
	snapshot: Array<{ chainId: string; label: string; balance: bigint }>,
	ethUsdPrice: number,
	usdcOnArb: number,
	targetUsd: number,
): { chainId: string; label: string; balance: bigint; usdValue: number } | null {
	let totalUsd = usdcOnArb;
	let best: { chainId: string; label: string; balance: bigint } | null = null;
	for (const s of snapshot) {
		const ethUsd = parseFloat(formatUnits(s.balance, 18)) * ethUsdPrice;
		totalUsd += ethUsd;
		if (!best || s.balance > best.balance) best = s;
	}
	if (totalUsd >= targetUsd && best && best.balance > 0n) {
		return { ...best, usdValue: totalUsd };
	}
	return null;
}

// ============================================================================
// Step: bridgeToArbitrum
// ============================================================================

/**
 * Bridge native ETH from a source chain to Arbitrum via Li.Fi. Only runs when
 * the deposit was detected on a non-Arbitrum chain — Arbitrum deposits go
 * straight from waiting_deposit → swapping.
 *
 * Idempotent on retry:
 *   • If `bridge_destination_tx_hash` is already set, the bridge is fully
 *     complete — return immediately.
 *   • If `bridge_tx_hash` is set but destination isn't, the bridge was
 *     broadcast on a prior attempt — just poll Li.Fi status until DONE.
 *   • Otherwise, get a fresh quote, broadcast it, and poll status.
 */
async function stepBridgeToArbitrum(
	ctx: FundingContext,
	sourceChainId: string,
	sourceEthWei: bigint,
	existing?: any,
): Promise<void> {
	const sourceChain = SUPPORTED_SOURCE_CHAINS.find((c) => c.id === sourceChainId);
	if (!sourceChain) {
		throw new Error(`Source chain ${sourceChainId} is not in SUPPORTED_SOURCE_CHAINS`);
	}

	// Fully-bridged on a prior attempt — nothing to do.
	if (existing?.bridge_destination_tx_hash) {
		ctx.logger.info(
			`[funding] Skipping bridge — already complete (${existing.bridge_tx_hash} → ${existing.bridge_destination_tx_hash})`,
		);
		return;
	}

	const lifi = new Lifi();

	// Bridge already broadcast — just resume the status wait.
	if (existing?.bridge_tx_hash) {
		ctx.logger.info(
			`[funding] Resuming bridge wait — prior tx ${existing.bridge_tx_hash} not yet DONE`,
		);
		await waitForBridgeCompletion(ctx, lifi, existing.bridge_tx_hash);
		return;
	}

	await publishUpdate(
		ctx,
		"bridging",
		18,
		{ source_chain_id: sourceChainId },
		`Bridging from ${sourceChain.label} to Arbitrum...`,
	);

	// Reserve gas for the bridge tx on the source chain. L1 needs ~0.005 ETH,
	// L2s need ~0.0005 ETH (see SUPPORTED_SOURCE_CHAINS).
	const bridgeAmount = sourceEthWei - sourceChain.gasReserveWei;
	if (bridgeAmount <= 0n) {
		throw new Error(
			`Source ETH ${formatUnits(sourceEthWei, 18)} on ${sourceChain.label} is below the gas reserve ${formatUnits(sourceChain.gasReserveWei, 18)} — nothing to bridge`,
		);
	}

	ctx.logger.info(
		`[funding] Bridging ${formatUnits(bridgeAmount, 18)} ETH from ${sourceChain.label} (reserve ${formatUnits(sourceChain.gasReserveWei, 18)} for gas)`,
	);

	// Execute via LifiController — same controller-from-queue pattern used by
	// the swap step below. Native ETH on both sides (no ERC20 approval needed)
	// so the call is a single tx.
	const lifiController = new LifiController();
	lifiController.setContext(ctx.req);

	const result = await lifiController.postQuote(
		getAddress(ctx.jobData.agentWallet),
		ctx.req.headers.authorization,
		sourceChainId,
		"42161",
		NATIVE_ETH_ADDRESS,
		NATIVE_ETH_ADDRESS,
		bridgeAmount.toString(),
		getAddress(ctx.jobData.agentWallet),
		getAddress(ctx.jobData.agentWallet),
		undefined,
		0.5,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		false,
		true,
	);

	const sourceTxHash: string | undefined = result?.data?.signed?.broadcasted?.data;
	if (!sourceTxHash) {
		throw new Error(
			`Li.Fi bridge tx not broadcast — got: ${JSON.stringify(result?.data?.signed ?? result?.data ?? {}).slice(0, 400)}`,
		);
	}

	await ctx.serviceClient
		.from("agent_funding_jobs")
		.update({ bridge_tx_hash: sourceTxHash })
		.eq("job_id", ctx.jobData.jobId);

	await publishUpdate(
		ctx,
		"bridging",
		20,
		{ bridge_tx_hash: sourceTxHash, source_chain_id: sourceChainId },
		`Bridge broadcast on ${sourceChain.label} — waiting for confirmation on Arbitrum...`,
	);

	await waitForBridgeCompletion(ctx, lifi, sourceTxHash);
}

/**
 * Poll Li.Fi `getStatus(txHash)` until the bridge transitions to DONE.
 * Throws on FAILED or timeout. Persists the destination tx hash on success.
 */
async function waitForBridgeCompletion(
	ctx: FundingContext,
	lifi: Lifi,
	sourceTxHash: string,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < BRIDGE_TIMEOUT_MS) {
		await assertNotCancelled(ctx);

		const status = await lifi.getStatus(sourceTxHash).catch(() => null);
		const s = status?.status;

		if (s === "DONE") {
			const destTxHash = status?.receiving?.txHash;
			await ctx.serviceClient
				.from("agent_funding_jobs")
				.update({ bridge_destination_tx_hash: destTxHash })
				.eq("job_id", ctx.jobData.jobId);
			await publishUpdate(
				ctx,
				"bridging",
				22,
				{ bridge_destination_tx_hash: destTxHash },
				"Bridge complete — funds arrived on Arbitrum",
			);
			ctx.logger.info(
				`[funding] Bridge complete: source=${sourceTxHash} dest=${destTxHash}`,
			);
			return;
		}
		if (s === "FAILED" || s === "INVALID") {
			throw new Error(
				`Li.Fi bridge ${s.toLowerCase()}: substatus=${status?.substatus ?? "n/a"} tx=${sourceTxHash}`,
			);
		}
		await new Promise((r) => setTimeout(r, BRIDGE_STATUS_POLL_INTERVAL_MS));
	}
	throw new Error(
		`Bridge timeout after ${BRIDGE_TIMEOUT_MS / 60000} minutes — source tx ${sourceTxHash} did not transition to DONE. Funds remain on the source chain.`,
	);
}

// ============================================================================
// Step: swapEthToUsdc
// ============================================================================

/**
 * Swap all swappable ETH in the agent wallet to USDC via Odos.
 * Uses the full current ETH balance (minus gas reserve) rather than only the
 * newly-detected deposit delta — this picks up any pre-existing ETH from
 * prior runs, gas refunds, or other transfers automatically.
 * Returns the resulting USDC amount as a human-readable number.
 */
async function stepSwapEthToUsdc(
	ctx: FundingContext,
	_depositedWei: bigint,
	existing?: any,
): Promise<number> {
	// Idempotency: if a prior run already broadcast a swap and persisted its
	// output, verify the receipt and reuse the result instead of swapping
	// again. This protects against double-swaps on retry.
	if (existing?.swap_tx_hash && existing?.swap_output_usdc) {
		try {
			const receipt = await waitForReceipt(
				ctx.publicClient,
				existing.swap_tx_hash,
				ctx.logger,
			);
			if (receipt.status === "success") {
				ctx.logger.info(
					`[funding] Skipping swap — prior tx ${existing.swap_tx_hash} already confirmed`,
				);
				return Number(existing.swap_output_usdc);
			}
		} catch (e) {
			ctx.logger.warn(
				`[funding] Existing swap tx ${existing.swap_tx_hash} not confirmable on retry — re-attempting swap`,
			);
		}
	}

	await publishUpdate(ctx, "swapping", 25, {}, "Converting ETH to USDC...");

	// Use the full current ETH balance so any pre-existing ETH (leftover gas
	// reserve from a prior run, additional deposits, etc.) also gets swapped.
	// Routed through AccountController (Moon SDK) — same path as the multi-
	// chain polling loop — so we don't mix RPC sources.
	const balanceRes = await ctx.accountController.getBalance(
		getAddress(ctx.jobData.agentWallet),
		ctx.req.headers.authorization,
		ARBITRUM_CHAIN_ID,
	);
	const currentEthBalance = BigInt(balanceRes?.data?.balance ?? "0");
	const swapAmount = currentEthBalance - ETH_GAS_RESERVE;
	if (swapAmount <= 0n) {
		// No swappable ETH — check if the wallet already has USDC (e.g. from a
		// previous funding run). If so, skip the swap and let the pipeline
		// continue straight to credits / HL deposit.
		const existingUsdc = await readUsdcBalance(
			ctx.publicClient,
			ctx.jobData.agentWallet,
		);
		if (existingUsdc > 0) {
			ctx.logger.info(
				`[funding] No ETH to swap but wallet already has ${existingUsdc.toFixed(4)} USDC — skipping swap step`,
			);
			await publishUpdate(
				ctx,
				"swapping",
				40,
				{ swap_output_usdc: existingUsdc },
				`Using existing ${existingUsdc.toFixed(2)} USDC`,
			);
			return existingUsdc;
		}
		throw new Error("ETH balance is too small to swap after gas reserve and no USDC available");
	}
	ctx.logger.info(
		`[funding] Swapping ${formatUnits(swapAmount, 18)} ETH (wallet: ${formatUnits(currentEthBalance, 18)}, reserve: ${formatUnits(ETH_GAS_RESERVE, 18)})`,
	);

	// Read USDC balance before swap so we can compute the delta
	const usdcBefore = await readUsdcBalance(
		ctx.publicClient,
		ctx.jobData.agentWallet,
	);

	// Same-chain swap via Li.Fi. Sending fromChain == toChain (Arbitrum) makes
	// the /quote endpoint return a DEX-aggregator route (Odos / 1inch / etc.)
	// instead of a bridge. We previously called Odos directly here and hit its
	// public-tier 429 rate limit; Li.Fi already has an API key and aggregates
	// across multiple routers so it's more resilient for the funding flow.
	// Power-user trading paths still call OdosController for best-in-class
	// Arbitrum routing — only this small fund-swap moved to Li.Fi.
	const lifiController = new LifiController();
	lifiController.setContext(ctx.req);

	const swapResult = await lifiController.postQuote(
		getAddress(ctx.jobData.agentWallet),
		ctx.req.headers.authorization,
		ARBITRUM_CHAIN_ID,
		ARBITRUM_CHAIN_ID,
		NATIVE_ETH_ADDRESS,
		ARBITRUM_USDC,
		swapAmount.toString(),
		getAddress(ctx.jobData.agentWallet),
		getAddress(ctx.jobData.agentWallet),
		undefined,
		0.5,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		false,
		true,
	);

	const swapTxHash: string | undefined =
		swapResult?.data?.signed?.broadcasted?.data;
	if (!swapTxHash) {
		throw new Error(
			`Li.Fi swap tx not broadcast — got: ${JSON.stringify(swapResult?.data?.signed ?? swapResult?.data ?? {}).slice(0, 400)}`,
		);
	}

	// Wait for swap confirmation
	const receipt = await waitForReceipt(
		ctx.publicClient,
		swapTxHash,
		ctx.logger,
	);
	if (receipt.status !== "success") {
		throw new Error(`Swap tx reverted: ${swapTxHash}`);
	}

	// Read post-swap USDC balance and compute the actual amount received
	const usdcAfter = await readUsdcBalance(
		ctx.publicClient,
		ctx.jobData.agentWallet,
	);
	const usdcReceived = usdcAfter - usdcBefore;

	if (usdcReceived <= 0) {
		throw new Error(
			`Swap appeared to succeed but USDC balance did not increase (before: ${usdcBefore}, after: ${usdcAfter})`,
		);
	}

	await publishUpdate(
		ctx,
		"swapping",
		40,
		{
			swap_tx_hash: swapTxHash,
			swap_input_eth: parseFloat(formatUnits(swapAmount, 18)),
			swap_output_usdc: usdcReceived,
		},
		`Swapped to ${usdcReceived.toFixed(2)} USDC`,
	);

	return usdcReceived;
}

// ============================================================================
// Step: buyCredits + confirmCredits + grantCredits
// ============================================================================

/**
 * Sends $25 USDC from the agent wallet to the credits collection wallet.
 * Captures both wallets' before-balances so confirmCredits can verify the
 * deltas after broadcast.
 */
async function stepBuyCredits(
	ctx: FundingContext,
	existing?: any,
): Promise<{ txHash: string; agentBefore: number; collectionBefore: number }> {
	// Idempotency: if we already broadcast the credits transfer on a prior
	// attempt, reuse the persisted state instead of double-spending.
	if (
		existing?.credits_tx_hash &&
		existing?.agent_usdc_before_credits != null &&
		existing?.collection_usdc_before_credits != null
	) {
		ctx.logger.info(
			`[funding] Skipping credits transfer — prior tx ${existing.credits_tx_hash} already broadcast`,
		);
		return {
			txHash: existing.credits_tx_hash,
			agentBefore: Number(existing.agent_usdc_before_credits),
			collectionBefore: Number(existing.collection_usdc_before_credits),
		};
	}

	await publishUpdate(
		ctx,
		"buying_credits",
		50,
		{},
		`Sending $${CREDITS_USDC_COST} USDC for credits...`,
	);

	// Snapshot both balances BEFORE the transfer
	const agentBefore = await readUsdcBalance(
		ctx.publicClient,
		ctx.jobData.agentWallet,
	);
	const collectionBefore = await readUsdcBalance(
		ctx.publicClient,
		CREDITS_COLLECTION_WALLET,
	);

	await ctx.serviceClient
		.from("agent_funding_jobs")
		.update({
			agent_usdc_before_credits: agentBefore,
			collection_usdc_before_credits: collectionBefore,
		})
		.eq("job_id", ctx.jobData.jobId);

	// Send via ERC20Controller — uses the agent's authenticated context
	const erc20Controller = new ERC20Controller();
	erc20Controller.setContext(ctx.req);

	const amountWei = parseUnits(String(CREDITS_USDC_COST), 6).toString();

	const transferResult = await erc20Controller.transfer(
		getAddress(ctx.jobData.agentWallet),
		ctx.req.supabaseSession,
		{
			contract_address: ARBITRUM_USDC,
			account: getAddress(ctx.jobData.agentWallet),
			to: getAddress(CREDITS_COLLECTION_WALLET),
			amount: amountWei,
			chain_id: ARBITRUM_CHAIN_ID,
			dryrun: false,
			broadcast: true,
			simulate: false,
		} as any,
	);

	if (!transferResult.success || !transferResult.data?.broadcasted?.data) {
		throw new Error(
			`Credits USDC transfer failed: ${transferResult.message ?? "unknown"}`,
		);
	}

	const txHash = transferResult.data.broadcasted.data;

	await publishUpdate(
		ctx,
		"buying_credits",
		60,
		{ credits_tx_hash: txHash },
		"Credits payment broadcast — confirming...",
	);

	return { txHash, agentBefore, collectionBefore };
}

/**
 * Confirm the credits purchase via three checks:
 *   1. Tx receipt has status === "success"
 *   2. Agent USDC balance dropped by ~$25 (within tolerance for gas dust)
 *   3. Collection wallet USDC balance went up by AT LEAST $25
 */
async function stepConfirmCredits(
	ctx: FundingContext,
	txHash: string,
	agentBefore: number,
	collectionBefore: number,
): Promise<void> {
	await publishUpdate(
		ctx,
		"confirming_credits",
		65,
		{},
		"Verifying credits payment on chain...",
	);

	// Check 1: receipt status
	const receipt = await waitForReceipt(ctx.publicClient, txHash, ctx.logger);
	if (receipt.status !== "success") {
		throw new Error(`Credits transfer tx reverted: ${txHash}`);
	}

	// Check 2 + 3: balance deltas
	const [agentAfter, collectionAfter] = await Promise.all([
		readUsdcBalance(ctx.publicClient, ctx.jobData.agentWallet),
		readUsdcBalance(ctx.publicClient, CREDITS_COLLECTION_WALLET),
	]);

	await ctx.serviceClient
		.from("agent_funding_jobs")
		.update({
			agent_usdc_after_credits: agentAfter,
			collection_usdc_after_credits: collectionAfter,
		})
		.eq("job_id", ctx.jobData.jobId);

	const agentDrop = agentBefore - agentAfter;
	const collectionRise = collectionAfter - collectionBefore;

	if (agentDrop < CREDITS_USDC_COST - USDC_BALANCE_TOLERANCE) {
		throw new Error(
			`Agent USDC balance check failed: expected drop of ~$${CREDITS_USDC_COST}, actual drop $${agentDrop.toFixed(4)}`,
		);
	}
	if (collectionRise < CREDITS_USDC_COST) {
		throw new Error(
			`Collection wallet USDC check failed: expected rise of at least $${CREDITS_USDC_COST}, actual rise $${collectionRise.toFixed(4)}`,
		);
	}

	ctx.logger.info(
		`[funding] Credits payment confirmed for job ${ctx.jobData.jobId}: agent -$${agentDrop.toFixed(2)}, collection +$${collectionRise.toFixed(2)}`,
	);
}

/**
 * Grant credits to the user via the add_credits RPC and insert an audit row
 * into billing_transactions tagged with the on-chain tx hash.
 */
async function stepGrantCredits(
	ctx: FundingContext,
	txHash: string,
	existing?: any,
): Promise<void> {
	if (existing?.credits_granted && Number(existing.credits_granted) > 0) {
		ctx.logger.info(
			`[funding] Skipping grant credits — already granted ${existing.credits_granted}`,
		);
		return;
	}

	await publishUpdate(
		ctx,
		"granting_credits",
		70,
		{},
		`Adding ${CREDITS_AMOUNT} credits to your account...`,
	);

	const { error: rpcError } = await ctx.serviceClient.rpc("add_credits", {
		p_account_id: ctx.jobData.userId,
		p_credits: CREDITS_AMOUNT,
	});

	if (rpcError) {
		throw new Error(`add_credits RPC failed: ${rpcError.message}`);
	}

	// Audit row
	await ctx.serviceClient.from("billing_transactions").insert({
		account_id: ctx.jobData.userId,
		amount: CREDITS_USDC_COST,
		credits_purchased: CREDITS_AMOUNT,
		type: "credit_purchase",
		status: "completed",
		payment_provider: "x402",
		metadata: {
			source: "agent_funding_queue",
			agent_id: ctx.jobData.agentId,
			tx_hash: txHash,
			job_id: ctx.jobData.jobId,
			collection_wallet: CREDITS_COLLECTION_WALLET,
		},
	});

	await ctx.serviceClient
		.from("agent_funding_jobs")
		.update({ credits_granted: CREDITS_AMOUNT })
		.eq("job_id", ctx.jobData.jobId);

	await publishUpdate(
		ctx,
		"granting_credits",
		78,
		{ credits_granted: CREDITS_AMOUNT },
		`${CREDITS_AMOUNT} credits added to your account`,
	);
}

// ============================================================================
// Step: depositToHyperliquid
// ============================================================================

/**
 * Deposits the remaining USDC to Hyperliquid via HLController.
 * Reads the agent's current USDC balance and deposits all of it minus a tiny
 * dust buffer (to avoid rounding-related "insufficient balance" errors).
 */
async function stepDepositToHyperliquid(
	ctx: FundingContext,
	existing?: any,
): Promise<void> {
	if (existing?.hl_deposit_tx_hash) {
		ctx.logger.info(
			`[funding] Skipping HL deposit — prior tx ${existing.hl_deposit_tx_hash} already broadcast`,
		);
		return;
	}

	await publishUpdate(
		ctx,
		"depositing_hl",
		82,
		{},
		"Depositing USDC to Hyperliquid...",
	);

	const usdcBalance = await readUsdcBalance(
		ctx.publicClient,
		ctx.jobData.agentWallet,
	);

	// Leave a tiny buffer to avoid balance-vs-amount rounding mismatch
	const depositAmount = Math.max(0, usdcBalance - 0.01);

	if (depositAmount < 2) {
		// HL accepts deposits as low as ~$2; below that something went badly wrong
		throw new Error(
			`Insufficient USDC for HL deposit: ${depositAmount.toFixed(4)} USDC (minimum 2)`,
		);
	}

	const hlController = new HLController();
	hlController.setContext(ctx.req);

	const depositResult = await hlController.deposit(
		getAddress(ctx.jobData.agentWallet),
		ctx.req.headers.authorization,
		{ amount: depositAmount.toFixed(2) },
	);

	if (!depositResult.success || !depositResult.data?.txHash) {
		throw new Error(
			`HL deposit failed: ${depositResult.message ?? "unknown"}`,
		);
	}

	await publishUpdate(
		ctx,
		"depositing_hl",
		95,
		{
			hl_deposit_tx_hash: depositResult.data.txHash,
			hl_deposit_amount_usdc: depositAmount,
		},
		`Deposited $${depositAmount.toFixed(2)} to Hyperliquid`,
	);
}

// ============================================================================
// Main job processor
// ============================================================================

async function processFundingJob(
	job: Job<SignedAgentFundingJob>,
): Promise<{ success: boolean; jobId: string }> {
	// Verify signed job (prevents tampering)
	if (!validator.verifyJob(job.data)) {
		throw new Error("Invalid job signature - possible tampering detected");
	}

	const jobData = job.data.data;
	const logger = workerLogger.child({
		jobId: jobData.jobId,
		userId: jobData.userId,
		agentId: jobData.agentId,
	});

	logger.info(
		"[funding] ════════════════════════════════════════════════════════════",
	);
	logger.info(
		`[funding] ▶ JOB PICKED UP  bullJobId=${job.id} fundingJobId=${jobData.jobId}`,
	);
	logger.info(
		`[funding]   agent=${jobData.agentId} wallet=${jobData.agentWallet}`,
	);
	logger.info(
		`[funding]   amountUsd=${jobData.amountUsd} method=${jobData.fundingMethod} buyCredits=${jobData.buyCredits}`,
	);
	logger.info(
		`[funding]   bullmq attempt=${job.attemptsMade + 1}/${job.opts?.attempts ?? 1}`,
	);
	logger.info(
		"[funding] ════════════════════════════════════════════════════════════",
	);

	// Build authenticated request context (matches odos-market-order pattern)
	const pubsub = new VaultPubSub(config.pubsub);
	const serviceClient = createClient(
		config.supabase.url,
		config.supabase.serviceKey,
		{ auth: { persistSession: false } },
	);

	// Bump retry counter
	await serviceClient.rpc("increment_attempt_count" as any).then(() => { }).catch(() => { });
	await serviceClient
		.from("agent_funding_jobs")
		.update({
			last_attempted_at: new Date().toISOString(),
		})
		.eq("job_id", jobData.jobId);

	let token: { access_token: string };
	try {
		token = await generateToken(jobData.userId);
	} catch (err: any) {
		logger.error(`Failed to generate token: ${err.message}`);
		throw err;
	}

	const userSupabase = createClient(config.supabase.url, config.supabase.anonKey, {
		auth: { persistSession: false },
		global: {
			headers: {
				Authorization: `Bearer ${token.access_token}`,
				"X-Supabase-Auth": `${token.access_token}`,
			},
		},
	});

	const { data: userData } = await userSupabase.auth.getUser(token.access_token);

	const req: any = {
		user: userData.user,
		supabaseSession: token.access_token,
		supabase: userSupabase,
		pubsub,
		logger,
		headers: {
			authorization: `Bearer ${token.access_token}`,
			accept: "application/json",
			"content-type": "application/json",
		},
	};

	// Arbitrum-only viem client — retained ONLY for ERC20 (USDC) token reads
	// via `readContract`. Native ETH balance reads have moved to the
	// AccountController path; do not add new `publicClient.getBalance` calls.
	const publicClient = createPublicClient({
		chain: arbitrum,
		transport: http(),
	});

	// One AccountController per job, request-bound. Used for native ETH
	// balance lookups across every supported chain in `readAllChainBalances`
	// and the pre-swap balance check in `stepSwapEthToUsdc`.
	const accountController = new AccountController();
	accountController.setContext(req);

	const ctx: FundingContext = {
		job,
		jobData,
		logger,
		pubsub,
		supabase: userSupabase,
		serviceClient,
		req,
		channel: getFundingJobChannel(jobData.jobId, jobData.userId),
		publicClient,
		accountController,
	};

	// Load existing persisted state for idempotency on retries.
	const existing = await loadJobRow(ctx);

	// Top-level cancellation guard. The row may already be `cancelled` if a
	// new /start call superseded this job before the worker picked it up, or
	// `complete` if a prior worker finished it and BullMQ delivered a stale
	// retry. In either case, exit cleanly — running the pipeline now would
	// either duplicate on-chain transfers (cancelled) or pointlessly re-check
	// already-completed steps (complete).
	if (existing?.state === "cancelled" || existing?.state === "complete") {
		logger.info(
			`[funding] Job ${jobData.jobId} picked up but row is already "${existing.state}" — skipping without running pipeline`,
		);
		return { success: false, jobId: jobData.jobId };
	}

	try {
		// ── Step 1: Wait for deposit (any supported chain) ──
		const detection = await runStep(ctx, "waiting_deposit", () =>
			stepWaitForDeposit(ctx, existing),
		);

		// ── Step 1b (conditional): Bridge to Arbitrum if needed ──
		// Skip when the deposit landed directly on Arbitrum (chainId "42161"),
		// or when it was a USDC pre-fill (ethWei === 0n).
		if (detection.chainId !== "42161" && detection.ethWei > 0n) {
			const afterDeposit = await loadJobRow(ctx);
			await runStep(ctx, "bridging", () =>
				stepBridgeToArbitrum(
					ctx,
					detection.chainId,
					detection.ethWei,
					afterDeposit,
				),
			);
		}

		// ── Step 2: Swap ETH → USDC on Arbitrum ──
		// stepSwapEthToUsdc reads the agent's current Arbitrum ETH balance,
		// so bridged-in ETH is picked up automatically.
		await runStep(ctx, "swapping", () =>
			stepSwapEthToUsdc(ctx, detection.ethWei, existing),
		);

		// ── Step 3 (optional): Buy credits ──
		// Skip credits if the agent wallet doesn't have enough USDC to both
		// pay for credits AND still meet the HL minimum deposit threshold.
		// This protects low-value funding runs (e.g. $10) from getting stuck
		// at the HL deposit step with an insufficient balance error.
		const HL_MIN_DEPOSIT = 2; // USDC — HL accepts deposits as low as $2
		const usdcForCreditsCheck = await readUsdcBalance(ctx.publicClient, ctx.jobData.agentWallet);
		const effectiveBuyCredits = jobData.buyCredits && !existing?.credits_tx_hash &&
			(usdcForCreditsCheck - CREDITS_USDC_COST) >= HL_MIN_DEPOSIT;
		if (!effectiveBuyCredits && jobData.buyCredits && !existing?.credits_tx_hash) {
			ctx.logger.warn(
				`[funding] Skipping credits purchase — wallet has ${usdcForCreditsCheck.toFixed(4)} USDC, not enough to pay $${CREDITS_USDC_COST} credits and still meet HL minimum ($${HL_MIN_DEPOSIT})`,
			);
		}
		if (effectiveBuyCredits || existing?.credits_tx_hash) {
			// Reload state after the swap so the credits step sees the latest row.
			const afterSwap = await loadJobRow(ctx);
			const { txHash, agentBefore, collectionBefore } = await runStep(
				ctx,
				"buying_credits",
				() => stepBuyCredits(ctx, afterSwap),
			);
			// Skip confirmation if a prior run already verified balances.
			const needsConfirm =
				!afterSwap?.agent_usdc_after_credits ||
				!afterSwap?.collection_usdc_after_credits;
			if (needsConfirm) {
				await runStep(ctx, "confirming_credits", () =>
					stepConfirmCredits(ctx, txHash, agentBefore, collectionBefore),
				);
			}
			await runStep(ctx, "granting_credits", () =>
				stepGrantCredits(ctx, txHash, afterSwap),
			);
		} // end credits block

		// ── Step 4: Deposit remaining USDC to Hyperliquid ──
		const beforeHl = await loadJobRow(ctx);
		await runStep(ctx, "depositing_hl", () =>
			stepDepositToHyperliquid(ctx, beforeHl),
		);

		// ── Done ──
		await publishUpdate(
			ctx,
			"complete",
			100,
			{ completed_at: new Date().toISOString() },
			"Agent funded and trading on Hyperliquid",
		);

		logger.info(
			"[funding] ════════════════════════════════════════════════════════════",
		);
		logger.info(
			`[funding] ✓ JOB COMPLETE  fundingJobId=${jobData.jobId}`,
		);
		logger.info(
			"[funding] ════════════════════════════════════════════════════════════",
		);
		return { success: true, jobId: jobData.jobId };
	} catch (err: any) {
		// Cancellation: the row is already in the correct `cancelled` state
		// (set by /start or /cancel). Do NOT call failJob (would overwrite
		// state to `failed`) and do NOT rethrow (would trigger BullMQ retry).
		if (err instanceof JobCancelledError) {
			logger.info(
				"[funding] ════════════════════════════════════════════════════════════",
			);
			logger.info(
				`[funding] ⏹ JOB CANCELLED  fundingJobId=${jobData.jobId} — superseded or cancelled by user`,
			);
			logger.info(
				"[funding] ════════════════════════════════════════════════════════════",
			);
			return { success: false, jobId: jobData.jobId };
		}

		logger.error(
			"[funding] ════════════════════════════════════════════════════════════",
		);
		logger.error(
			`[funding] ✗ JOB FAILED  fundingJobId=${jobData.jobId}`,
		);
		logger.error(
			`[funding]   ${err instanceof FundingStepError ? `step=${err.step}` : "step=unknown"} message=${err?.message ?? String(err)}`,
		);
		logger.error(
			"[funding] ════════════════════════════════════════════════════════════",
		);
		await failJob(ctx, err, null);
		throw err; // Triggers BullMQ retry mechanism
	}
}

// ============================================================================
// Queue export
// ============================================================================

export default {
	name: "agent-funding",
	process: processFundingJob,
	concurrency: 100,
	settings: {
		timeout: DEPOSIT_TIMEOUT_MS, // application-level timeout for the job
		/**
		 * BullMQ lock duration — keep SHORT. The worker renews this automatically
		 * every 15s while alive. If the worker dies, the lock expires in 30s and
		 * the job becomes stalled so another worker can pick it up. This is
		 * separate from `timeout` which is the application-level max run time.
		 */
		lockDuration: 30_000,
		removeOnComplete: { age: 86400, count: 200 },
		removeOnFail: { age: 7 * 86400, count: 200 },
		attempts: 3,
		backoff: {
			type: "exponential",
			delay: 5000,
		},
		maxStalledCount: 2,
		stallInterval: 15_000, // check for stalled jobs every 15s (was 2 min)
	},
};
