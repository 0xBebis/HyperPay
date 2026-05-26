# Circle CCTP + Hypercore: Self-Funding AI Agents

> AI trading agents on Hyperliquid earn USDC, use Circle CCTP to bridge it cross-chain, buy their own compute credits, and reinvest in better trading strategies — a fully autonomous, self-sustaining loop powered by Circle's Cross-Chain Transfer Protocol.

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Payment Flows](#payment-flows)
  - [1. CCTP Credit Purchase (Hyperliquid → Base)](#1-cctp-credit-purchase-hyperliquid--base)
  - [2. X402 Gasless Payment (EIP-3009)](#2-x402-gasless-payment-eip-3009)
  - [3. Multi-Chain Agent Funding (CCTP Bridge)](#3-multi-chain-agent-funding-cctp-bridge)
- [Technical Deep Dive](#technical-deep-dive)
  - [CCTP Settlement Verification](#cctp-settlement-verification)
  - [CCTP Burn / Attest / Mint Lifecycle](#cctp-burn--attest--mint-lifecycle)
  - [EIP-3009 Gasless USDC Transfers](#eip-3009-gasless-usdc-transfers)
  - [Multi-Chain Deposit Detection](#multi-chain-deposit-detection)
  - [State Machine & Idempotency](#state-machine--idempotency)
- [Key Design Decisions](#key-design-decisions)
- [Directory Structure](#directory-structure)
- [Tech Stack](#tech-stack)
- [Chain & Contract Configuration](#chain--contract-configuration)
- [Reusable Packages](#reusable-packages)

---

## Overview

AI agents on our platform trade perpetual futures on Hypercore (Hyperliquid). They earn USDC from successful trades. But the AI inference that powers their strategies — LLM calls, technical analysis, strategy generation — costs compute credits that live on a different chain (Base).

**Circle CCTP closes this loop.**

```
          ┌───────────────────────────────────────────────┐
          │                                               │
          ▼                                               │
   ┌─────────────┐    CCTP     ┌──────────┐    Credits   │
   │  Agent earns │  ────────► │  USDC    │  ─────────►  │
   │  USDC trading│  burn/     │  arrives │  buy compute  │
   │  on Hypercore│  attest/   │  on Base │  credits      │
   └─────────────┘  mint      └──────────┘               │
          ▲                                               │
          │           ┌──────────────┐                    │
          │           │ Credits fuel │                    │
          └────────── │ AI inference │ ◄──────────────────┘
                      │ → better     │
                      │   strategies │
                      └──────────────┘
```

**The self-sustaining agent loop:**

1. **Earn** — Agent trades on Hypercore and accumulates USDC profit in its margin account
2. **Bridge** — CCTP burns USDC on Hypercore, Circle attests the message, USDC is minted on Base
3. **Buy credits** — Agent transfers USDC on Base to the platform's collection wallet
4. **Compute** — Credits fuel LLM calls, strategy generation, and technical analysis
5. **Trade better** — Improved strategies earn more USDC → cycle repeats

We built three complementary payment rails around CCTP to make this work:

| Rail | Flow | Mechanism | Gas Model |
|------|------|-----------|-----------|
| **CCTP Credit Purchase** | Hypercore → Base | Circle CCTP via HL's `sendToEvmWithData` | Automatic forwarding (`0x` data) |
| **X402 Gasless Payment** | Any wallet (Base USDC) → Platform | EIP-3009 `transferWithAuthorization` | Gasless for payer |
| **Multi-Chain Agent Funding** | USDC on any CCTP chain → Hypercore | Circle CCTP burn/attest/mint | Platform-sponsored |

All three rails converge on the same backend: atomically recording the payment, updating credit balances, and emitting real-time events via Redis PubSub → Socket.IO so the frontend updates instantly.

---

## Architecture

```
                                    ┌─────────────────────────────────────┐
                                    │          Frontend (Next.js)          │
                                    │                                     │
                                    │  ┌──────────┐  ┌────────────────┐  │
                                    │  │Credit     │  │X402PaymentFlow │  │
                                    │  │Purchase   │  │(EIP-3009)      │  │
                                    │  └─────┬─────┘  └───────┬────────┘  │
                                    │        │                │           │
                                    │  ┌─────┴────────────────┴────────┐  │
                                    │  │    useX402Payment Hook        │  │
                                    │  │  - Balance check              │  │
                                    │  │  - EIP-712 signing            │  │
                                    │  │  - Network switching          │  │
                                    │  │  - Agent wallet support       │  │
                                    │  └──────────────┬────────────────┘  │
                                    │                 │ X-Payment header  │
                                    └─────────────────┼───────────────────┘
                                                      │
                            ┌─────────────────────────┼─────────────────────────┐
                            │         Backend API      │    (Express + TSOA)      │
                            │                          ▼                         │
                            │  ┌──────────────────────────────────────────────┐  │
                            │  │            BillingController                  │  │
                            │  │                                              │  │
                            │  │  POST /billing/x402/credits/purchase         │  │
                            │  │    → Verify X402 payment header              │  │
                            │  │    → settle_x402_credit_purchase (atomic)    │  │
                            │  │                                              │  │
                            │  │  POST /billing/hl/{account}/credits/purchase │  │
                            │  │    → HLExchange.sendToEvmWithData()          │  │
                            │  │    → Poll CCTP deposit (HL ledger)           │  │
                            │  │    → Poll fill (Across indexer)              │  │
                            │  │    → settle_cctp_credit_purchase (atomic)    │  │
                            │  └──────────────────────────────────────────────┘  │
                            │                          │                         │
                            │  ┌──────────────────┐   │   ┌──────────────────┐  │
                            │  │  Agent Funding    │   │   │  HLExchange      │  │
                            │  │  Queue (BullMQ)   │   │   │  Wrapper         │  │
                            │  │                   │   │   │                  │  │
                            │  │  waiting_deposit  │   │   │  sendToEvmWith   │  │
                            │  │  → bridging       │   │   │    Data()        │  │
                            │  │    (CCTP burn/    │   │   │                  │  │
                            │  │     attest/mint)  │   │   │  getCCTPTransfers│  │
                            │  │  → buying_credits │   │   │    ()            │  │
                            │  │  → confirming     │   │   │                  │  │
                            │  │  → granting       │   │   │                  │  │
                            │  │  → depositing_hl  │   │   │                  │  │
                            │  │  → complete       │   │   │                  │  │
                            │  └──────────────────┘   │   └──────────────────┘  │
                            │                         │                         │
                            │  ┌──────────────────────┴──────────────────────┐  │
                            │  │              PostgreSQL (Supabase)           │  │
                            │  │                                             │  │
                            │  │  settle_x402_credit_purchase()  — atomic    │  │
                            │  │  settle_cctp_credit_purchase()  — atomic    │  │
                            │  │  billing_transactions           — audit     │  │
                            │  │  credit_balances                — ledger    │  │
                            │  │  agent_funding_jobs             — state     │  │
                            │  └─────────────────────────────────────────────┘  │
                            └───────────────────────────────────────────────────┘

External Services — all Circle CCTP native:

  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
  │ Hyperliquid  │  │ Circle       │  │ Across       │
  │ Exchange API │  │ CCTP / Iris  │  │ Indexer API  │
  │              │  │              │  │              │
  │ sendToEvmWith│  │ Attestation  │  │ Settlement   │
  │ Data()       │  │ service      │  │ verification │
  │ Ledger query │  │ (burn/mint)  │  │ (HL fills)   │
  └──────────────┘  └──────────────┘  └──────────────┘
```

---

## Payment Flows

### 1. CCTP Credit Purchase (Hyperliquid → Base)

Users with USDC in their Hyperliquid perp margin can purchase platform credits in a single API call. The backend orchestrates the entire cross-chain CCTP transfer:

```
User clicks "Purchase Credits" (HL wallet)
  │
  ▼
POST /billing/hl/{account}/credits/purchase
  │
  ├─ 1. Permission check (owner or billing_admin)
  ├─ 2. Calculate package amount + credits
  ├─ 3. Initialize HLExchange with user's Moon wallet
  │
  ├─ 4. hlExchange.sendToEvmWithData({
  │       token: "USDC",
  │       amount: finalAmount,
  │       destinationRecipient: PAYMENT_WALLET,
  │       destinationChainId: 6,        ← CCTP Domain ID for Base
  │       data: "0x",                   ← Enables auto-forwarding (no dest gas needed)
  │       gasLimit: 200000
  │     })
  │
  │     Under the hood — Circle CCTP:
  │     Hypercore → burn USDC → Circle attestation → mint USDC on Base
  │
  ├─ 5. Poll for deposit confirmation (HL ledger)
  │     └─ getCCTPTransfers() filters ledger for sends to 0x2000...0000
  │        (HL's internal CCTP bridge address)
  │
  ├─ 6. Poll for fill confirmation (Across indexer)
  │     └─ GET https://indexer.api.across.to/hyperliquid-transfers
  │        Match: originChainId=999 (HyperEVM), destinationChainId=8453, nonce
  │
  ├─ 7. Atomic settlement (PostgreSQL RPC)
  │     └─ settle_cctp_credit_purchase() — idempotent insert + credit update
  │
  ├─ 8. Emit PubSub event: credits.added.{accountId}
  │
  └─ 9. Return { success: true, credits, transactionId }
```

**Key files:** [`examples/backend/controllers/billing.controller.ts`](examples/backend/controllers/billing.controller.ts) | Package: [`packages/cctp-verify/`](packages/cctp-verify/)

### 2. X402 Gasless Payment (EIP-3009)

The X402 protocol implements [HTTP 402 Payment Required](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/402) with EIP-3009 `transferWithAuthorization` for truly gasless USDC payments:

```
Frontend                                  Backend
  │                                         │
  ├─ 1. User selects "Web3 Wallet"          │
  │     payment method                      │
  │                                         │
  ├─ 2. Create X402 requirements:           │
  │     {                                   │
  │       network: "base",                  │
  │       asset: BASE_USDC,                 │
  │       maxAmountRequired: "25000000",    │  ← 25 USDC in 6-decimal atomic units
  │       payTo: PLATFORM_WALLET,           │
  │       maxTimeoutSeconds: 300            │
  │     }                                   │
  │                                         │
  ├─ 3. useX402Payment hook:                │
  │     a. Switch network to Base           │
  │     b. Check USDC balance               │
  │     c. Generate random 32-byte nonce    │
  │     d. Sign EIP-712 typed data:         │
  │        TransferWithAuthorization {      │
  │          from, to, value,               │
  │          validAfter, validBefore,       │
  │          nonce                           │
  │        }                                │
  │     e. Encode payload → base64          │
  │                                         │
  ├─ 4. Send request with header:  ────────►│
  │     X-Payment: <base64 payload>         │
  │                                         ├─ 5. Verify signature
  │                                         ├─ 6. Execute transferWithAuthorization
  │                                         │     on-chain (backend pays gas)
  │                                         ├─ 7. settle_x402_credit_purchase()
  │◄──────────────────────────────── 8.     ├─ 8. Return success + credits
  │                                         │
  │  User paid $0 gas.                      │
  │  Backend paid ~$0.001 gas on Base.      │
```

**Key files:** Package: [`packages/x402/`](packages/x402/) | Example integration: [`examples/frontend/hooks/x402/`](examples/frontend/hooks/x402/)

### 3. Multi-Chain Agent Funding (CCTP Bridge)

AI trading agents need USDC deposited on Hyperliquid to trade. The funding pipeline uses Circle CCTP to bridge USDC from any supported chain — no DEX swaps or bridge aggregators needed. CCTP burns USDC on the source chain, Circle's attestation service signs the message, and native USDC is minted on the destination.

```
State Machine (CCTP-native — no swap step):

  waiting_deposit ──► Poll USDC balance across all CCTP chains
       │               (Ethereum, Arbitrum, Base, Optimism, Avalanche,
       │                Polygon, Hypercore)
       │               Threshold: 95% of committed USDC amount
       │
       ▼
  ┌─ bridging ──────► Circle CCTP: burn → attestation → mint
  │    (if not on     Phase 1: Burn USDC on source chain
  │     target chain)   (TokenMessenger.depositForBurn or HL sendToEvmWithData)
  │                   Phase 2: Poll Circle Iris API for attestation
  │                   Phase 3: Mint USDC on destination chain
  │                     (MessageTransmitter.receiveMessage)
  │                   Idempotent: resumes from burn_tx_hash or attestation on retry
  │
  └──► buying_credits ► ERC20 transfer $25 USDC → collection wallet
       │                 (optional, if buyCredits=true)
       │
       ▼
  confirming_credits ─► Wait for tx receipt + dual-balance verification
       │                 (sender decreased, receiver increased)
       │
       ▼
  granting_credits ───► PostgreSQL RPC: add_credits + billing_transactions
       │
       ▼
  depositing_exchange ► Deposit remaining USDC to Hyperliquid for trading
       │
       ▼
  complete ───────────► Terminal success — agent is funded and ready to trade
```

**Why CCTP instead of a bridge aggregator?** Circle CCTP burns and mints native USDC — there is no wrapped token, no liquidity pool risk, and no slippage. The agent receives exactly the USDC it sent, minus zero fees (Circle does not charge for CCTP). Since agents deal exclusively in USDC (it is the margin currency on Hyperliquid), there is no need for a swap step at all.

**Key features:**
- Polls USDC balances across all CCTP-supported chains simultaneously
- Three-phase bridge: burn → attestation → mint (no intermediary tokens)
- Full idempotency — every phase persists state; crashes resume exactly where they left off
- Attestation caching — fetched attestations are persisted so retries skip the polling phase
- CCTP timeout protection with clear error messages
- Pre-arrival detection for users who funded before the job started

**Key files:** Package: [`packages/funding-pipeline/`](packages/funding-pipeline/) | Production version: [`examples/backend/queue/agent-funding.queue.ts`](examples/backend/queue/agent-funding.queue.ts)

---

## Technical Deep Dive

### CCTP Settlement Verification

We use a **dual verification** strategy to confirm CCTP transfers from Hyperliquid:

**1. Source-side (Hyperliquid Ledger):**
```typescript
async getCCTPTransfers(user: Address, startTime: number) {
  const ledgerUpdates = await this.getLedgerUpdates(user, startTime);
  return ledgerUpdates.filter((update) =>
    update.delta.type === 'send' &&
    update.delta.destination === '0x2000000000000000000000000000000000000000'
  );
}
```
The magic address `0x2000000000000000000000000000000000000000` is Hyperliquid's internal CCTP bridge address. Any `send` to this address represents a CCTP withdrawal.

**2. Destination-side (Across Protocol Indexer):**
```typescript
const transfers = await axios.get(
  `https://indexer.api.across.to/hyperliquid-transfers?direction=out&user=${account}`
);
const transfer = transfers.data.find((t) =>
  t.originChainId === 999 &&              // HyperEVM
  t.destinationChainId === 8453 &&        // Base
  t.nonce === depositTx.nonce.toString()   // Nonce-based ordering
);
```

This dual-poll runs every 2 seconds for up to 5 minutes, first finding the source transaction on HL, then waiting for the fill on the destination chain.

### CCTP Burn / Attest / Mint Lifecycle

The funding pipeline implements the full Circle CCTP lifecycle as three idempotent phases:

```typescript
// Phase 1: Burn USDC on source chain
const burnResult = await cctp.burn({
  wallet: agentWallet,
  sourceChainId: "999",              // Hypercore
  destinationDomain: 6,              // Base (CCTP domain)
  amount: 100_000_000n,              // 100 USDC in 6-decimal atomic units
  destinationRecipient: agentWallet,
});
// Persist burn_tx_hash for idempotency

// Phase 2: Poll Circle attestation service
// The attestation service signs the burn message once it is finalized
const attestation = await cctp.getAttestation({
  burnTxHash: burnResult.txHash,
  sourceChainId: "999",
});
// attestation.status: "pending" → "complete"
// Persist attestation + message for idempotency

// Phase 3: Mint USDC on destination chain
// Calls MessageTransmitter.receiveMessage(message, attestation)
const mintResult = await cctp.mint({
  attestation: attestation.attestation,
  message: attestation.message,
  destinationChainId: "8453",        // Base
  wallet: agentWallet,
});
// Agent now has native USDC on Base
```

**Idempotency at every phase:**
- If `mint_tx_hash` is set, the bridge is complete — skip entirely
- If `burn_tx_hash` is set but mint is not, resume from attestation polling
- If `cctp_attestation` is cached, skip directly to mint
- Otherwise, initiate a fresh burn

### EIP-3009 Gasless USDC Transfers

The X402 flow uses EIP-3009 (`transferWithAuthorization`) — a USDC-native standard that allows gasless transfers via signed authorizations:

```typescript
// User signs this EIP-712 typed data (no gas spent)
const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

// Validity window: -10 minutes to +5 minutes
const validAfter = BigInt(Math.floor(Date.now() / 1000) - 600);
const validBefore = BigInt(Math.floor(Date.now() / 1000) + 300);
```

The signed authorization is base64-encoded into an `X-Payment` header. The backend calls `transferWithAuthorization` on the USDC contract, paying the gas itself (~$0.001 on Base).

**Agent wallet support:** The same flow works for AI agent wallets via the Moon SDK's `sign-typed-data` API, enabling agents to pay for premium content autonomously.

### Multi-Chain Deposit Detection

The funding pipeline polls USDC balances across all CCTP-supported chains simultaneously:

```typescript
const CCTP_CHAINS: CctpChain[] = [
  { id: "1",     label: "Ethereum",    cctpDomain: 0 },
  { id: "43114", label: "Avalanche",   cctpDomain: 1 },
  { id: "10",    label: "Optimism",    cctpDomain: 2 },
  { id: "42161", label: "Arbitrum",    cctpDomain: 3 },
  { id: "noble-1", label: "Noble",     cctpDomain: 4 },
  { id: "solana",  label: "Solana",    cctpDomain: 5 },
  { id: "8453",  label: "Base",        cctpDomain: 6 },
  { id: "137",   label: "Polygon PoS", cctpDomain: 7 },
  { id: "sui",   label: "Sui",         cctpDomain: 8 },
  { id: "999",   label: "Hypercore",   cctpDomain: -1 },  // Custom path via HL
];
```

**Threshold logic:** Rather than triggering on dust, we require 95% of the committed USDC amount (`fundingTargetFraction = 0.95`). This handles:
- Multi-transaction deposits (user sends $30, then $70)
- Fee variance from upstream sources
- Incidental dust transfers

**No swap step needed:** Because CCTP burns and mints native USDC, the agent receives the same token on the destination chain. There is no need to swap from a wrapped or bridged token into USDC.

### State Machine & Idempotency

Every step in the funding pipeline is idempotent:

```typescript
// Example: CCTP bridge step checks for prior completion before doing work
if (existing?.mint_tx_hash) {
  // Bridge already complete on prior attempt — skip
  return;
}
if (existing?.burn_tx_hash) {
  // Burn broadcast but not minted — resume from attestation polling
  if (existing?.cctp_attestation && existing?.cctp_message) {
    // Attestation cached — skip directly to mint
    await mint(existing.cctp_attestation, existing.cctp_message);
  } else {
    await pollAttestation(existing.burn_tx_hash);
  }
  return;
}
// Fresh start — initiate burn, poll attestation, mint
```

State is persisted to PostgreSQL on every transition. If the BullMQ worker crashes mid-step, the job resumes exactly where it left off. No double-burns, no double-mints, no double-credit-grants.

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Circle CCTP as the sole bridge protocol** | CCTP burns and mints native USDC with zero slippage and zero fees. Since Hyperliquid agents deal exclusively in USDC, there is no need for a generic bridge aggregator or DEX routing. |
| **CCTP via Hyperliquid's `sendToEvmWithData`** | Users already have USDC in HL margin. Direct CCTP withdrawal avoids the user needing to withdraw to Arbitrum first, then bridge. Single API call. |
| **`data: "0x"` for auto-forwarding** | Setting the data field to `0x` enables automatic forwarding on the destination chain, eliminating the need for the recipient to have gas on the destination. |
| **No swap step in the pipeline** | CCTP burns/mints the same token (USDC) natively. No wrapped tokens, no AMM liquidity pools, no slippage. The entire pipeline is USDC-in/USDC-out. |
| **Three-phase idempotent bridge (burn/attest/mint)** | Each phase is persisted independently. A crash after burn but before attestation resumes from attestation polling. A crash after attestation but before mint jumps directly to mint. No re-burns. |
| **Across indexer for fill verification** | The Across protocol indexes HL CCTP transfers with nonce-based ordering, providing a reliable way to verify settlement without running our own bridge indexer. |
| **EIP-3009 over EIP-2612 (permit)** | `transferWithAuthorization` is natively supported by Circle's USDC contract. Unlike `permit`, it uses a random nonce (replay-safe) and doesn't require the user to have any tokens for gas. |
| **X402 as an HTTP standard** | Follows the HTTP 402 spec proposal. Any client that speaks HTTP can participate — no SDK lock-in. The `X-Payment` header is just base64 JSON. |
| **95% funding threshold** | Prevents the pipeline from running on dust while accommodating multi-tx deposits and upstream fee variance. |
| **Provider fallback pattern** | HLExchange uses a Proxy-based fallback: tries the official HL SDK first, falls back to a proxy provider on HTTP 429. Only rate-limit errors trigger fallback; API rejections throw immediately. |
| **Atomic settlement RPCs** | `settle_cctp_credit_purchase` and `settle_x402_credit_purchase` are PostgreSQL functions that atomically insert the billing transaction AND update the credit balance. Idempotent via `ON CONFLICT` clauses. |

---

## Directory Structure

```
cctp-bridge-submission/
├── README.md                                    # This file
├── package.json                                 # Workspace root
├── tsconfig.json                                # Shared TypeScript config
│
├── packages/                                    # REUSABLE — fork these
│   ├── x402/                                    # X402 Payment Protocol
│   │   ├── src/types/                           #   Protocol types, network registry, utils
│   │   ├── src/client/                          #   Framework-agnostic signing & balance
│   │   ├── src/server/                          #   Express middleware & facilitator client
│   │   └── src/react/                           #   React hook (wagmi adapter)
│   │
│   ├── cctp-verify/                             # CCTP Settlement Verification
│   │   ├── src/poller.ts                        #   Dual-poll verification engine
│   │   ├── src/interfaces.ts                    #   SourceVerifier / DestinationVerifier
│   │   └── src/verifiers/                       #   Hyperliquid + Across implementations
│   │
│   └── funding-pipeline/                        # CCTP-Native Funding Pipeline
│       ├── src/pipeline.ts                      #   State machine orchestrator
│       ├── src/interfaces.ts                    #   Pluggable provider interfaces (CCTP-native)
│       ├── src/types.ts                         #   State machine, CCTP chain config (all 10 chains)
│       ├── src/steps/                           #   wait-deposit, bridge (CCTP), credits, deposit
│       └── src/utils/                           #   Error handling utilities
│
├── examples/                                    # REFERENCE — shows production integration
│   ├── README.md                                #   Context for example files
│   ├── backend/
│   │   ├── controllers/billing.controller.ts    #   CCTP + X402 credit purchase endpoints
│   │   ├── library/hl/                          #   Hyperliquid exchange wrapper
│   │   ├── queue/agent-funding.queue.ts         #   1825-line BullMQ pipeline (pre-extraction)
│   │   └── database/                            #   PostgreSQL atomic settlement RPCs
│   └── frontend/
│       ├── components/                          #   Payment UI, bridge modals
│       ├── hooks/                               #   X402 signing hook, funding job tracker
│       └── types/                               #   Standalone X402 type definitions
│
└── docs/
    └── flow-diagrams.md                         # ASCII sequence & state machine diagrams
```

---

## Tech Stack

**Core Protocol:**
- **Circle CCTP** — Cross-Chain Transfer Protocol for native USDC burn/attest/mint across 10 chains
- **Circle Iris API** — Attestation service for CCTP message signing
- **EIP-3009** — `transferWithAuthorization` for gasless USDC transfers
- **EIP-712** — Typed data signing for X402 payment authorization

**Backend:**
- TypeScript / Node.js / Express / TSOA
- BullMQ (Redis-backed job queues)
- PostgreSQL (Supabase) with atomic RPC functions
- Redis PubSub → Socket.IO for real-time updates

**Frontend:**
- Next.js 16 / React 19 / TypeScript
- wagmi v3 + viem v2 (Ethereum interactions)
- TanStack Query v5 (server state)
- Zustand (client state)
- Tailwind CSS v4 + shadcn/ui

**Blockchain:**
- Circle CCTP (burn/attest/mint across all supported domains)
- Hyperliquid Exchange API (`sendToEvmWithData` for Hypercore CCTP)
- Across Protocol Indexer (settlement verification for HL fills)

---

## Chain & Contract Configuration

All 10 chains supported by Circle CCTP v2, plus Hypercore (Hyperliquid):

| Chain | Chain ID | CCTP Domain | USDC Address | TokenMessenger | Role |
|-------|----------|:-----------:|-------------|----------------|------|
| **Ethereum** | 1 | 0 | `0xA0b8...eB48` | `0xBd3f...3155` | Funding source |
| **Avalanche** | 43114 | 1 | `0xB97E...a6E` | `0x6B25...6982` | Funding source |
| **Optimism** | 10 | 2 | `0x0b2C...Ff85` | `0x2B40...528f` | Funding source |
| **Arbitrum** | 42161 | 3 | `0xaf88...5831` | `0x1933...f22A` | Primary target (HL deposits) |
| **Noble** | noble-1 | 4 | `uusdc` | — | Cosmos CCTP |
| **Solana** | solana | 5 | `EPjFW...Dt1v` | — | Funding source |
| **Base** | 8453 | 6 | `0x8335...2913` | `0x1682...F962` | CCTP destination, X402 payments |
| **Polygon PoS** | 137 | 7 | `0x3c49...3359` | `0x9daF...3FE` | Funding source |
| **Sui** | sui | 8 | `0xdba3...USDC` | — | Funding source |
| **Hypercore** | 999 | -1 (custom) | `USDC` (internal) | — | CCTP origin via `sendToEvmWithData` |

**Key Addresses:**
- **Platform Payment Wallet:** `0x87f1d896e39f0629c7a391d255364ed9C4a47Da0`
- **HL CCTP Bridge Address:** `0x2000000000000000000000000000000000000000` (internal)
- **Circle Attestation API:** `https://iris-api.circle.com` (production) / `https://iris-api-sandbox.circle.com` (testnet)

---

## Reusable Packages

The core primitives have been extracted into three standalone, framework-agnostic packages that any developer can integrate into their own project. Each package uses dependency injection — bring your own database, wallet provider, and CCTP implementation.

### `@cod3x/x402` — X402 Payment Protocol

Drop-in gasless USDC payments via HTTP 402 + EIP-3009.

```typescript
// Client: sign a payment (works with any wallet — wagmi, ethers, Moon SDK)
import { signTransferAuthorization, generateNonce, createValidityWindow } from "@cod3x/x402/client";

const signed = await signTransferAuthorization(yourSigner, {
  from: walletAddress,
  to: merchantAddress,
  value: 25_000_000n, // $25 USDC
  ...createValidityWindow(),
  nonce: generateNonce(),
  usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  tokenName: "USD Coin",
  tokenVersion: "2",
  chainId: 8453,
});

// Server: protect any Express endpoint with X402 payments
import { createX402Middleware, X402PaymentLibrary, DefaultFacilitatorClient } from "@cod3x/x402/server";

app.post("/premium", createX402Middleware({
  library: new X402PaymentLibrary(yourPersistenceAdapter, new DefaultFacilitatorClient()),
  persistence: yourPersistenceAdapter,
  resourceType: "premium_content",
  getPayToAddress: () => "0xYOUR_WALLET",
  getAmount: () => 0.10,
}), handler);
```

**Package:** [`packages/x402/`](packages/x402/)

### `@cod3x/cctp-verify` — CCTP Settlement Verification

Dual-poll verification pattern for any cross-chain transfer protocol.

```typescript
import { dualPollVerify, HyperliquidSourceVerifier, AcrossDestinationVerifier } from "@cod3x/cctp-verify";

const result = await dualPollVerify(
  new HyperliquidSourceVerifier({
    getCCTPTransfers: (account, time) => yourHLClient.getCCTPTransfers(account, time),
  }),
  new AcrossDestinationVerifier(),
  { account: "0x...", initiatedAfter: Date.now(), expectedAmount: 25, expectedToken: "USDC",
    originChainId: 999, destinationChainId: 8453 },
);
// result.fillTxHash = settlement tx on Base
```

**Package:** [`packages/cctp-verify/`](packages/cctp-verify/)

### `@cod3x/funding-pipeline` — CCTP-Native Funding State Machine

Idempotent, resumable pipeline for detecting USDC deposits across chains, bridging via Circle CCTP (burn/attest/mint), purchasing credits, and depositing to a trading exchange.

```typescript
import { FundingPipeline } from "@cod3x/funding-pipeline";

const pipeline = new FundingPipeline({
  balance: yourUsdcBalanceProvider,
  cctp: yourCctpBridgeProvider,      // burn → attestation → mint
  transfer: yourTransferProvider,
  receipt: yourReceiptProvider,
  deposit: yourDepositProvider,
  credits: yourCreditsProvider,
  state: yourStateStore,
  events: yourEventEmitter,
  cancellation: yourCancellationChecker,
  logger: console,
});

await pipeline.run({
  jobId: "abc",
  userId: "...",
  agentId: "...",
  agentWallet: "0x...",
  amountUsdc: 100,
  buyCredits: true,
});
```

**Package:** [`packages/funding-pipeline/`](packages/funding-pipeline/)

---

## License

Proprietary. Submitted for hackathon review only.
