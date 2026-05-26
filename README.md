# HyperPay

This is the payments infrastructure from [Cod3x](https://cod3x.org), ripped out and open-sourced. It handles cross-chain USDC payments using Circle CCTP, gasless credit purchases via X402, and multi-chain agent funding.

We built this so our AI trading agents on Hyperliquid could fund their own compute. Agents earn USDC from trading, bridge it cross-chain via CCTP, buy platform credits, and use those credits to run inference. The whole loop is autonomous.

**This isn't a polished SDK you install from npm.** It's production code extracted into clean, documented packages with well-defined interfaces. The intent is that you read through it, understand how it works, and copy what you need into your own project. Everything is MIT licensed, so do whatever you want with it.

If you're using a coding agent (Claude, Cursor, Copilot, etc.), point it at [`AGENTS.md`](AGENTS.md) for instructions on how to integrate these packages into your codebase.

## Quick Start

```bash
git clone https://github.com/0xBebis/HyperPay.git
cd HyperPay
npm install
```

Three packages under `packages/`, each self-contained. Zero external dependencies beyond `viem` (peer dep for x402 only).

## Packages

### `@hyperpay/x402` - Gasless USDC payments

HTTP 402 + EIP-3009. Users sign an off-chain authorization, backend settles it on-chain. Zero gas for the payer.

```typescript
// Client: sign a payment
import { signTransferAuthorization, generateNonce, createValidityWindow } from "@hyperpay/x402/client";

const signed = await signTransferAuthorization(signer, {
  from: walletAddress,
  to: merchantAddress,
  value: 25_000_000n, // $25 USDC (6 decimals)
  ...createValidityWindow(),
  nonce: generateNonce(),
  usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  tokenName: "USD Coin",
  tokenVersion: "2",
  chainId: 8453,
});

// Server: protect any Express route
import { createX402Middleware, X402PaymentLibrary, DefaultFacilitatorClient } from "@hyperpay/x402/server";

app.post("/premium", createX402Middleware({
  library: new X402PaymentLibrary(persistence, new DefaultFacilitatorClient()),
  persistence,
  resourceType: "premium_content",
  getPayToAddress: () => "0xYOUR_WALLET",
  getAmount: () => 0.10,
}), handler);
```

Includes a React hook (`@hyperpay/x402/react`) that wraps wagmi for wallet signing. Works with any signer that implements the `X402Signer` interface.

### `@hyperpay/cctp-verify` - CCTP settlement verification

Polls source and destination chains until a CCTP transfer settles. Ships with Hyperliquid and Across verifiers, but the interfaces are generic.

```typescript
import { dualPollVerify, HyperliquidSourceVerifier, AcrossDestinationVerifier } from "@hyperpay/cctp-verify";

const result = await dualPollVerify(
  new HyperliquidSourceVerifier({
    getCCTPTransfers: (account, time) => hlClient.getCCTPTransfers(account, time),
  }),
  new AcrossDestinationVerifier(),
  {
    account: "0x...",
    initiatedAfter: Date.now(),
    expectedAmount: 25,
    expectedToken: "USDC",
    originChainId: 999,
    destinationChainId: 8453,
  },
);
```

### `@hyperpay/funding-pipeline` - Multi-chain agent funding

State machine that detects USDC deposits across 10 CCTP chains, bridges via burn/attest/mint, buys credits, and deposits to Hyperliquid. Every step is idempotent and persists state, so crashes resume where they left off.

```typescript
import { FundingPipeline } from "@hyperpay/funding-pipeline";

const pipeline = new FundingPipeline({
  balance: usdcBalanceProvider,
  cctp: cctpBridgeProvider,
  transfer: transferProvider,
  receipt: receiptProvider,
  deposit: depositProvider,
  credits: creditsProvider,
  state: stateStore,
  events: eventEmitter,
  cancellation: cancellationChecker,
  logger: console,
});

await pipeline.run({
  jobId: "fund-123",
  userId: "user-456",
  agentId: "agent-789",
  agentWallet: "0x...",
  amountUsdc: 100,
  buyCredits: true,
});
```

All providers are interfaces. Bring your own database, wallet infrastructure, and RPC.

## How it fits together

```
Agent earns USDC on Hypercore
       |
       v
  CCTP burn on Hypercore (sendToEvmWithData)
       |
  Circle attestation (~60-90s)
       |
  CCTP mint on Base
       |
  X402 credit purchase (gasless, EIP-3009)
       |
  Credits fund AI inference
       |
  Better strategies -> more USDC -> repeat
```

The funding pipeline automates this entire loop. The X402 package handles the credit purchase step. The cctp-verify package confirms settlement.

## Supported Chains

| Chain | CCTP Domain | USDC Address |
|-------|:-----------:|-------------|
| Ethereum | 0 | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
| Avalanche | 1 | `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E` |
| Optimism | 2 | `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85` |
| Arbitrum | 3 | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` |
| Noble | 4 | `uusdc` |
| Solana | 5 | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| Base | 6 | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Polygon PoS | 7 | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` |
| Sui | 8 | `0xdba346...::usdc::USDC` |
| Hypercore | -1 | Internal (via HL exchange API) |

Contract addresses for TokenMessenger and MessageTransmitter are in [`packages/funding-pipeline/src/types.ts`](packages/funding-pipeline/src/types.ts).

## Repo Structure

```
packages/
  x402/                    # X402 payment protocol
    src/types/             #   Protocol types, network config, utils
    src/client/            #   Signing, payload encoding, balance checks
    src/server/            #   Express middleware, facilitator client
    src/react/             #   React hook (wagmi adapter)

  cctp-verify/             # CCTP settlement verification
    src/poller.ts          #   Dual-poll engine
    src/interfaces.ts      #   SourceVerifier, DestinationVerifier
    src/verifiers/         #   Hyperliquid + Across implementations

  funding-pipeline/        # Multi-chain funding state machine
    src/pipeline.ts        #   Orchestrator
    src/interfaces.ts      #   Provider interfaces (all injectable)
    src/types.ts           #   Chain config, state machine types
    src/steps/             #   wait-deposit, bridge, credits, deposit

examples/                  # Reference integration (not runnable standalone)
  backend/                 #   Billing controller, HL wrapper, funding queue
  frontend/                #   Payment UI, bridge modals, funding hooks

docs/
  flow-diagrams.md         #   ASCII sequence diagrams
```

## Design Decisions

- **CCTP only, no bridge aggregators.** CCTP burns and mints native USDC with zero slippage and zero fees. Agents deal exclusively in USDC, so there is no need for DEX routing.
- **No swap step.** CCTP moves the same token (USDC) across chains. No wrapped tokens, no AMM pools.
- **Three-phase bridge (burn/attest/mint).** Each phase persists independently. A crash after burn resumes from attestation. A crash after attestation skips to mint.
- **EIP-3009 over EIP-2612.** `transferWithAuthorization` uses a random nonce (replay-safe) and the payer needs zero gas. Natively supported by Circle's USDC contract.
- **X402 over custom payment endpoints.** Follows the HTTP 402 spec. The `X-Payment` header is just base64 JSON. No SDK lock-in.
- **Atomic settlement.** Credit purchases and balance updates happen in a single PostgreSQL transaction via `ON CONFLICT` for idempotency.

## License

MIT. Do whatever you want with it.
