# Integration Guide for Coding Agents

This file tells you how to integrate HyperPay's payment infrastructure into another project. Read this first, then look at the code.

## What this repo contains

Three packages extracted from Cod3x's production payments stack:

1. **`packages/x402/`** - Gasless USDC payments using HTTP 402 + EIP-3009
2. **`packages/cctp-verify/`** - Circle CCTP settlement verification (dual-poll pattern)
3. **`packages/funding-pipeline/`** - Multi-chain USDC funding state machine using CCTP

Plus `examples/` showing how Cod3x uses them in production (not runnable standalone, just for reference).

## How to integrate

Don't install these as npm packages. Copy the source files you need into your project and adapt them.

### Step 1: Pick what you need

- **Just want gasless USDC payments?** Copy `packages/x402/`.
- **Need to verify CCTP transfers?** Copy `packages/cctp-verify/`.
- **Building a multi-chain funding flow?** Copy `packages/funding-pipeline/` (and probably `cctp-verify` too).

### Step 2: Copy the package source

Each package is under `packages/<name>/src/`. Copy the `src/` directory into your project wherever you keep shared libraries. The TypeScript files have zero internal dependencies between packages and only reference `viem` as an external dep.

Example for a Next.js project:
```
your-project/
  lib/
    x402/          <- copy from packages/x402/src/
    cctp-verify/   <- copy from packages/cctp-verify/src/
```

### Step 3: Implement the interfaces

Every package uses dependency injection. You provide the implementations, not the package.

#### For `x402/server` (Express middleware)

You need to implement `PaymentPersistence` (see `packages/x402/src/server/interfaces.ts`):

```typescript
// your-project/lib/x402/my-persistence.ts
import type { PaymentPersistence } from "./server/interfaces";

export class PostgresPersistence implements PaymentPersistence {
  constructor(private db: YourDBClient) {}

  async findExistingPayment(params) {
    return this.db.query("SELECT * FROM x402_payments WHERE ...", params);
  }

  async logTransaction(params) {
    const result = await this.db.query("INSERT INTO x402_payments ...", params);
    return result.id;
  }

  async updateTransactionStatus(id, status) {
    await this.db.query("UPDATE x402_payments SET status = $1 WHERE id = $2", [status, id]);
  }

  async getPaymentConfig(resourceType, endpointPath) {
    return this.db.query("SELECT * FROM x402_configs WHERE ...");
  }

  async savePaymentConfig(config) {
    await this.db.query("INSERT INTO x402_configs ... ON CONFLICT DO UPDATE ...", config);
  }
}
```

Then wire it up:
```typescript
import { X402PaymentLibrary, DefaultFacilitatorClient, createX402Middleware } from "./lib/x402/server";
import { PostgresPersistence } from "./lib/x402/my-persistence";

const persistence = new PostgresPersistence(db);
const facilitator = new DefaultFacilitatorClient(); // uses Coinbase's facilitator
const library = new X402PaymentLibrary(persistence, facilitator, { baseUrl: "https://api.yourapp.com" });

app.post("/paid-endpoint", createX402Middleware({
  library,
  persistence,
  resourceType: "your_resource",
  getPayToAddress: () => "0xYOUR_WALLET",
  getAmount: () => 1.00, // $1 USDC
}), yourHandler);
```

#### For `x402/client` (browser signing)

If using React + wagmi, import the hook directly:
```typescript
import { useX402Payment } from "./lib/x402/react";
```

If using a different framework, use the core signing functions:
```typescript
import { signTransferAuthorization, generateNonce, createValidityWindow } from "./lib/x402/client/signing";
import { createPaymentPayload } from "./lib/x402/client/payload";
import { encodePaymentHeader } from "./lib/x402/types/utils";
```

You need to provide an `X402Signer` (any object with `address` and `signTypedData`).

#### For `cctp-verify`

Implement `SourceVerifier` and `DestinationVerifier` (or use the built-in Hyperliquid + Across ones):

```typescript
import { dualPollVerify } from "./lib/cctp-verify/poller";
import { HyperliquidSourceVerifier } from "./lib/cctp-verify/verifiers/hyperliquid";
import { AcrossDestinationVerifier } from "./lib/cctp-verify/verifiers/across";

const result = await dualPollVerify(
  new HyperliquidSourceVerifier({ getCCTPTransfers: yourFetchFn }),
  new AcrossDestinationVerifier(),
  { account, initiatedAfter: Date.now(), expectedAmount: 25, expectedToken: "USDC", originChainId: 999, destinationChainId: 8453 },
);
```

#### For `funding-pipeline`

This one has the most interfaces to implement (see `packages/funding-pipeline/src/interfaces.ts`):

- `UsdcBalanceProvider` - read USDC balances on any chain
- `CctpBridgeProvider` - execute CCTP burn/attest/mint
- `TransferProvider` - ERC20 transfers
- `TransactionReceiptProvider` - wait for tx confirmations
- `DepositProvider` - deposit to your exchange
- `CreditsProvider` - grant platform credits
- `StateStore` - persist pipeline state (any database)
- `FundingEventEmitter` - emit progress events (websocket, pubsub, etc.)
- `CancellationChecker` - check if a job was cancelled
- `FundingLogger` - logging

Look at `examples/backend/queue/agent-funding.queue.ts` for how Cod3x implements these against Supabase, BullMQ, and Hyperliquid's API.

### Step 4: Set up the database

For X402, you need two tables. See `examples/backend/database/settle_x402_credit_purchase.sql` for the schema.

For the funding pipeline, you need an `agent_funding_jobs` table. See `examples/backend/database/funding_multichain_bridge.sql`.

## Key files to read first

If you're trying to understand the architecture:

1. `packages/x402/src/server/middleware.ts` - the X402 payment flow in ~200 lines
2. `packages/cctp-verify/src/poller.ts` - the dual-poll verification pattern
3. `packages/funding-pipeline/src/pipeline.ts` - the state machine orchestrator
4. `packages/funding-pipeline/src/steps/bridge.ts` - CCTP burn/attest/mint in one file
5. `packages/funding-pipeline/src/types.ts` - all 10 CCTP chain configs with contract addresses

## Common modifications

**Switch settlement to Arc:** The billing controller already has Arc's CCTP domain (26) configured. When Arc launches on mainnet, update `CCTP_CONFIG` in the billing controller to `{ destinationChainId: 26, evmChainId: <arc_chain_id> }` and add Arc to `NETWORK_REGISTRY` in `packages/x402/src/types/network.ts`. Currently settling on Base (domain 6) as a stand-in.

**Change the target chain:** Edit `targetChainId` in `FundingConfig`. Default is `"42161"` (Arbitrum).

**Change credit pricing:** Edit `creditsUsdcCost` and `creditsAmount` in `FundingConfig`.

**Add a new CCTP chain:** Add an entry to `CCTP_CHAINS` in `packages/funding-pipeline/src/types.ts` with the chain ID, CCTP domain, and contract addresses.

**Use a different facilitator:** Pass a custom URL to `new DefaultFacilitatorClient("https://your-facilitator.com")` or implement the `FacilitatorClient` interface.

**Skip the credit purchase step:** Set `buyCredits: false` in the job data.

**Add a new payment network for X402:** Add an entry to `NETWORK_REGISTRY` in `packages/x402/src/types/network.ts`.
