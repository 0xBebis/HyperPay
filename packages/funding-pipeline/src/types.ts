/**
 * Funding Pipeline Types -- CCTP-Native
 *
 * State machine types, job data, and CCTP chain configuration for the
 * multi-chain agent funding pipeline. USDC-only -- no ETH swaps needed
 * since Circle CCTP burns/mints USDC natively across chains.
 *
 * @packageDocumentation
 */

// ============================================================================
// State Machine
// ============================================================================

/**
 * Possible states of a funding pipeline job.
 *
 * The pipeline progresses linearly through these states:
 * `waiting_deposit` -> `bridging` -> `buying_credits` -> `confirming_credits`
 * -> `granting_credits` -> `depositing_exchange` -> `complete`
 *
 * Terminal states: `complete`, `failed`, `cancelled`.
 */
export type FundingState =
  | "waiting_deposit"
  | "bridging"
  | "buying_credits"
  | "confirming_credits"
  | "granting_credits"
  | "depositing_exchange"
  | "complete"
  | "failed"
  | "cancelled";

// ============================================================================
// Job Data
// ============================================================================

/**
 * Input data required to start a funding pipeline job.
 *
 * Passed into {@link FundingPipeline.run} to kick off the multi-step
 * funding flow for an AI trading agent.
 *
 * @example
 * ```ts
 * const jobData: FundingJobData = {
 *   jobId: "fund-abc123",
 *   userId: "user-456",
 *   agentId: "agent-789",
 *   agentWallet: "0x1234...abcd",
 *   amountUsdc: 100,
 *   buyCredits: true,
 * };
 * ```
 */
export interface FundingJobData {
  /** Unique identifier for this funding job. Used for idempotency and state persistence. */
  jobId: string;
  /** Platform user ID that owns the agent. Used for credit grants. */
  userId: string;
  /** AI agent identifier that will receive the funded USDC. */
  agentId: string;
  /** EVM wallet address controlled by the agent. Deposits are detected here. */
  agentWallet: string;
  /** Target USDC amount for this funding round (human-readable, e.g. 100 = $100). */
  amountUsdc: number;
  /** Whether to purchase platform credits as part of the funding flow. */
  buyCredits: boolean;
}

/**
 * Result of deposit detection during the `waiting_deposit` step.
 *
 * Identifies which chain received the USDC and the exact atomic amount
 * so the pipeline knows whether a CCTP bridge is required.
 */
export interface DepositDetection {
  /** Chain where the USDC deposit was detected (e.g. "42161" for Arbitrum). */
  chainId: string;
  /** USDC amount detected in atomic units (6 decimals, i.e. 1 USDC = 1_000_000n). */
  usdcAmount: bigint;
}

// ============================================================================
// CCTP Chain Configuration
// ============================================================================

/**
 * A chain supported by Circle CCTP.
 *
 * Each chain has a unique CCTP domain ID used by the TokenMessenger contract
 * to route burn/mint messages. Hypercore uses Hyperliquid's native
 * `sendToEvmWithData` for CCTP bridging (domain -1 = custom path).
 */
export interface CctpChain {
  /** EVM chain ID or platform identifier (e.g. "1" for Ethereum, "999" for Hypercore). */
  id: string;
  /** Human-readable name (e.g. "Ethereum", "Arbitrum", "Hypercore"). */
  label: string;
  /** Circle CCTP domain ID. -1 for non-standard chains (Hypercore). */
  cctpDomain: number;
  /** USDC contract address on this chain. */
  usdcAddress: string;
  /** Circle TokenMessenger contract address (EVM chains only). */
  tokenMessenger?: string;
  /** Circle MessageTransmitter contract address (EVM chains only). */
  messageTransmitter?: string;
}

/**
 * All chains supported by Circle CCTP v2 + Hypercore (Hyperliquid).
 *
 * Domain IDs from: https://developers.circle.com/stablecoins/supported-domains
 */
export const CCTP_CHAINS: CctpChain[] = [
  {
    id: "1",
    label: "Ethereum",
    cctpDomain: 0,
    usdcAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    tokenMessenger: "0xBd3fa81B58Ba92a82136038B25aDec7066af3155",
    messageTransmitter: "0x0a992d191DEeC32aFe36203Ad87D7d289a738F81",
  },
  {
    id: "43114",
    label: "Avalanche",
    cctpDomain: 1,
    usdcAddress: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    tokenMessenger: "0x6B25532e1060CE10cc3B0A99e5683b91BFDe6982",
    messageTransmitter: "0x8186359aF5F57FbB40c6b14A588d2A59C0C29880",
  },
  {
    id: "10",
    label: "Optimism",
    cctpDomain: 2,
    usdcAddress: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    tokenMessenger: "0x2B4069517957735bE00ceE0fadAE88a26365528f",
    messageTransmitter: "0x4D41f22c5a0e5c74090899E5a8Fb597a8842b3e8",
  },
  {
    id: "42161",
    label: "Arbitrum",
    cctpDomain: 3,
    usdcAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    tokenMessenger: "0x19330d10D9Cc8751218eaf51E8885D058642E08A",
    messageTransmitter: "0xC30362313FBBA5cf9163F0bb16a0e01f01A896ca",
  },
  {
    id: "noble-1",
    label: "Noble",
    cctpDomain: 4,
    usdcAddress: "uusdc",
  },
  {
    id: "solana",
    label: "Solana",
    cctpDomain: 5,
    usdcAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  },
  {
    id: "8453",
    label: "Base",
    cctpDomain: 6,
    usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    tokenMessenger: "0x1682Ae6375C4E4A97e4B583BC394c861A46D8962",
    messageTransmitter: "0xAD09780d193884d503182aD4F75D113B9B1a7b67",
  },
  {
    id: "137",
    label: "Polygon PoS",
    cctpDomain: 7,
    usdcAddress: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    tokenMessenger: "0x9daF8c91AEFAE50b9c0E69629D3F6Ca40cA3B3FE",
    messageTransmitter: "0xF3be9355363857F3e001be68856A2f96b4C39Ba9",
  },
  {
    id: "sui",
    label: "Sui",
    cctpDomain: 8,
    usdcAddress:
      "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
  },
  {
    // Hypercore (Hyperliquid) — uses sendToEvmWithData for CCTP bridging.
    // Not a standard CCTP domain; the bridge is mediated by HL's exchange API.
    id: "999",
    label: "Hypercore",
    cctpDomain: -1,
    usdcAddress: "USDC",
  },
];

// ============================================================================
// Pipeline Configuration
// ============================================================================

/**
 * Configuration options for the funding pipeline.
 *
 * Controls chain selection, credit pricing, polling intervals, and timeouts
 * for each step in the funding flow. Override fields via
 * `new FundingPipeline(providers, { ...overrides })`.
 */
export interface FundingConfig {
  /** Chains to accept USDC deposits from. */
  supportedChains: CctpChain[];
  /** Target chain ID for the funded agent (e.g. "42161" for Arbitrum). */
  targetChainId: string;
  /** USDC contract address on the target chain. */
  targetUsdcAddress: string;
  /** Wallet that receives the credit purchase payment. */
  creditsCollectionWallet: string;
  /** USDC amount sent to collection wallet for credits (human-readable, e.g. 25 = $25). */
  creditsUsdcCost: number;
  /** Number of platform credits granted in exchange (e.g. 2500). */
  creditsAmount: number;
  /** Minimum fraction of committed USDC that must arrive before advancing (e.g. 0.95 = 95%). */
  fundingTargetFraction: number;
  /** Polling interval for deposit detection in milliseconds. */
  depositPollIntervalMs: number;
  /** Maximum time to wait for deposit arrival in milliseconds. */
  depositTimeoutMs: number;
  /** Polling interval for CCTP attestation in milliseconds. */
  attestationPollIntervalMs: number;
  /** Maximum time to wait for CCTP attestation + mint in milliseconds. */
  bridgeTimeoutMs: number;
  /** Polling interval for transaction receipt confirmation in milliseconds. */
  receiptPollIntervalMs: number;
  /** Maximum time to wait for transaction receipt in milliseconds. */
  receiptTimeoutMs: number;
  /** Minimum USDC for exchange deposit (below this, skip). Human-readable. */
  exchangeMinDeposit: number;
  /** Circle attestation API base URL (e.g. "https://iris-api-sandbox.circle.com"). */
  attestationApiUrl: string;
}

/**
 * Default configuration for the funding pipeline.
 *
 * Targets Arbitrum (chain 42161) with 30-minute timeouts for deposit and
 * bridge steps, 5-second polling intervals, and a $25 credit purchase
 * that grants 2500 platform credits.
 */
export const DEFAULT_FUNDING_CONFIG: FundingConfig = {
  supportedChains: CCTP_CHAINS,
  targetChainId: "42161",
  targetUsdcAddress: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  creditsCollectionWallet: "0x87f1d896e39f0629c7a391d255364ed9C4a47Da0",
  creditsUsdcCost: 25,
  creditsAmount: 2500,
  fundingTargetFraction: 0.95,
  depositPollIntervalMs: 5_000,
  depositTimeoutMs: 30 * 60 * 1000,
  attestationPollIntervalMs: 5_000,
  bridgeTimeoutMs: 30 * 60 * 1000,
  receiptPollIntervalMs: 3_000,
  receiptTimeoutMs: 5 * 60 * 1000,
  exchangeMinDeposit: 2,
  attestationApiUrl: "https://iris-api-sandbox.circle.com",
};

// ============================================================================
// Progress Events
// ============================================================================

/**
 * Real-time progress event emitted by the pipeline at each state transition.
 *
 * Consumers (e.g. WebSocket/PubSub listeners) use these to render live
 * funding status in the frontend.
 */
export interface FundingProgress {
  /** Job identifier this progress event belongs to. */
  jobId: string;
  /** Current state of the funding pipeline. */
  state: FundingState;
  /** Numeric progress indicator (0-100). */
  progress: number;
  /** Human-readable status message for UI display. */
  message?: string;
  /** Transaction hashes collected during the pipeline run. */
  txHashes?: {
    /** Tx hash of the initial USDC deposit detection. */
    deposit?: string;
    /** Tx hash of the CCTP burn on the source chain. */
    burn?: string;
    /** Message hash from Circle's attestation service. */
    attestation?: string;
    /** Tx hash of the CCTP mint on the destination chain. */
    mint?: string;
    /** Tx hash of the credit purchase USDC transfer. */
    credits?: string;
    /** Tx hash of the exchange deposit (e.g. Hyperliquid). */
    exchangeDeposit?: string;
  };
}
