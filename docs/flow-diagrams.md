# Flow Diagrams

## CCTP Credit Purchase — Sequence Diagram

```
┌──────┐     ┌─────────────┐    ┌──────────┐    ┌──────────┐    ┌─────────┐    ┌──────────┐
│Client│     │Billing      │    │HLExchange│    │Hyperliquid│   │Across   │    │PostgreSQL│
│      │     │Controller   │    │          │    │API        │   │Indexer  │    │          │
└──┬───┘     └──────┬──────┘    └────┬─────┘    └────┬──────┘   └────┬────┘    └────┬─────┘
   │                │                │               │              │              │
   │ POST /billing/ │                │               │              │              │
   │ hl/{acct}/     │                │               │              │              │
   │ credits/       │                │               │              │              │
   │ purchase       │                │               │              │              │
   │───────────────>│                │               │              │              │
   │                │                │               │              │              │
   │                │ Verify perms   │               │              │              │
   │                │ Calc credits   │               │              │              │
   │                │                │               │              │              │
   │                │ sendToEvmWith  │               │              │              │
   │                │ Data()         │               │              │              │
   │                │───────────────>│               │              │              │
   │                │                │  CCTP burn    │              │              │
   │                │                │──────────────>│              │              │
   │                │                │               │              │              │
   │                │                │  { status:ok }│              │              │
   │                │                │<──────────────│              │              │
   │                │                │               │              │              │
   │                │ Poll: getCCTP  │               │              │              │
   │                │ Transfers()    │               │              │              │
   │                │───────────────>│               │              │              │
   │                │                │ getLedger     │              │              │
   │                │                │ Updates()     │              │              │
   │                │                │──────────────>│              │              │
   │                │                │               │              │              │
   │                │                │  [filter:     │              │              │
   │                │                │   dest=0x2000]│              │              │
   │                │                │<──────────────│              │              │
   │                │  { hash, nonce}│               │              │              │
   │                │<───────────────│               │              │              │
   │                │                │               │              │              │
   │                │ Poll: findFill │               │              │              │
   │                │ Operation()    │               │              │              │
   │                │────────────────────────────────────────────>  │              │
   │                │                │               │   Match:     │              │
   │                │                │               │   origin=999 │              │
   │                │                │               │   dest=8453  │              │
   │                │                │               │   nonce match│              │
   │                │  { fillTxnRef }│               │              │              │
   │                │<───────────────────────────────────────────── │              │
   │                │                │               │              │              │
   │                │ settle_cctp_   │               │              │              │
   │                │ credit_purchase│               │              │              │
   │                │ ()             │               │              │              │
   │                │─────────────────────────────────────────────────────────────>│
   │                │                │               │              │     Atomic:  │
   │                │                │               │              │     INSERT tx│
   │                │                │               │              │     UPDATE   │
   │                │                │               │              │     credits  │
   │                │  { tx_id }     │               │              │              │
   │                │<────────────────────────────────────────────────────────────│
   │                │                │               │              │              │
   │  { success,    │                │               │              │              │
   │    credits,    │                │               │              │              │
   │    txId }      │                │               │              │              │
   │<───────────────│                │               │              │              │
```

## Agent Funding State Machine (CCTP-Native)

```
                    ┌─────────────────┐
                    │ waiting_deposit  │ ◄── Entry point
                    │                 │
                    │ Poll USDC across│
                    │ 10 CCTP chains: │
                    │ ETH, AVAX, OP,  │
                    │ ARB, Noble, SOL,│
                    │ Base, Polygon,  │
                    │ Sui, Hypercore  │
                    │                 │
                    │ Threshold: 95%  │
                    │ of committed    │
                    └────────┬────────┘
                             │
                ┌────────────┼────────────┐
                │            │            │
         Non-target      Target chain  Already has
         USDC deposit    USDC deposit  USDC on target
                │            │            │
                ▼            │            │
   ┌────────────────────┐   │            │
   │     bridging        │   │            │
   │                     │   │            │
   │  ┌── Phase 1 ──┐   │   │            │
   │  │ CCTP Burn    │   │   │            │
   │  │ TokenMessenger│  │   │            │
   │  │ .depositFor  │   │   │            │
   │  │  Burn()      │   │   │            │
   │  └──────────────┘   │   │            │
   │         │            │   │            │
   │  ┌── Phase 2 ──┐   │   │            │
   │  │ Attestation  │   │   │            │
   │  │ Poll Circle  │   │   │            │
   │  │ Iris API     │   │   │            │
   │  └──────────────┘   │   │            │
   │         │            │   │            │
   │  ┌── Phase 3 ──┐   │   │            │
   │  │ CCTP Mint    │   │   │            │
   │  │ Message      │   │   │            │
   │  │ Transmitter  │   │   │            │
   │  │ .receive     │   │   │            │
   │  │  Message()   │   │   │            │
   │  └──────────────┘   │   │            │
   └──────────┬──────────┘   │            │
              │              │            │
              ▼              ▼            │
        ┌──────────────────────┐         │
        │   buying_credits     │◄────────┘
        │                      │
        │ USDC transfer to     │
        │ collection wallet    │
        └──────────┬───────────┘
                   │
                   ▼
        ┌──────────────────────┐
        │ confirming_credits   │
        │                      │
        │ Wait for tx receipt  │
        │ Verify balance       │
        └──────────┬───────────┘
                   │
                   ▼
        ┌──────────────────────┐
        │  granting_credits    │
        │                      │
        │ PostgreSQL RPC:      │
        │  add_credits()       │
        └──────────┬───────────┘
                   │
                   ▼
        ┌──────────────────────┐
        │ depositing_exchange  │
        │                      │
        │ Deposit remaining    │
        │ USDC to Hyperliquid  │
        │ for trading          │
        └──────────┬───────────┘
                   │
                   ▼
        ┌──────────────────────┐
        │     complete         │  Terminal success
        │                      │  Agent is funded
        │                      │  and ready to trade
        └──────────────────────┘


   At any point:
        ┌──────────────────────┐
        │      failed          │  Terminal failure
        └──────────────────────┘  (step name + error)

        ┌──────────────────────┐
        │    cancelled         │  Superseded by new
        └──────────────────────┘  funding request
```

## CCTP Burn / Attest / Mint — Detail

```
Source Chain                Circle Iris API          Destination Chain
(e.g. Ethereum)            (Attestation)            (e.g. Arbitrum)
      │                          │                        │
      │                          │                        │
      │ 1. depositForBurn()      │                        │
      │ USDC burned by           │                        │
      │ TokenMessenger            │                        │
      │                          │                        │
      │ Burn event emitted       │                        │
      │ with message + nonce     │                        │
      │ ─────────────────────►   │                        │
      │                          │                        │
      │                    2. Circle signs                 │
      │                       attestation                 │
      │                       (~60-90 seconds)            │
      │                          │                        │
      │   3. Poll /attestations/ │                        │
      │      {messageHash}       │                        │
      │ ◄────────────────────    │                        │
      │   { status: "complete",  │                        │
      │     attestation: "0x.."} │                        │
      │                          │                        │
      │                          │    4. receiveMessage()  │
      │                          │    (message + attestation)
      │                          │  ────────────────────► │
      │                          │                        │
      │                          │    USDC minted by      │
      │                          │    MessageTransmitter  │
      │                          │                        │
      │                          │    Same amount, same   │
      │                          │    recipient, native   │
      │                          │    USDC (not wrapped)  │
      │                          │                        │

For Hypercore (Hyperliquid):
  Step 1 is replaced by sendToEvmWithData()
  Steps 2-4 are handled by HL's bridge infrastructure
  Settlement verified via Across Protocol indexer
```

## X402 Gasless Payment — Sequence Diagram

```
┌──────┐       ┌────────────┐    ┌──────────┐    ┌────────────┐    ┌──────────┐
│Client│       │useX402     │    │Wallet    │    │Backend     │    │PostgreSQL│
│      │       │Payment     │    │(MetaMask)│    │            │    │          │
└──┬───┘       └─────┬──────┘    └────┬─────┘    └─────┬──────┘    └────┬─────┘
   │                 │                │                │               │
   │ Click "Pay     │                │                │               │
   │  with USDC"    │                │                │               │
   │────────────────>│                │                │               │
   │                 │                │                │               │
   │                 │ Switch to Base │                │               │
   │                 │───────────────>│                │               │
   │                 │<───────────────│                │               │
   │                 │                │                │               │
   │                 │ balanceOf()    │                │               │
   │                 │ (read-only)    │                │               │
   │                 │───────────────>│                │               │
   │                 │  balance OK    │                │               │
   │                 │<───────────────│                │               │
   │                 │                │                │               │
   │                 │ signTypedData  │                │               │
   │                 │ (EIP-712)      │                │               │
   │                 │───────────────>│                │               │
   │                 │                │ [User signs    │               │
   │                 │                │  in wallet]    │               │
   │                 │  signature     │                │               │
   │                 │<───────────────│                │               │
   │                 │                │                │               │
   │                 │ Encode payload │                │               │
   │                 │ (base64)       │                │               │
   │                 │                │                │               │
   │ X-Payment hdr  │                │                │               │
   │<────────────────│                │                │               │
   │                 │                │                │               │
   │ POST /billing/x402/credits/purchase              │               │
   │ Header: X-Payment: <base64>     │                │               │
   │────────────────────────────────────────────────>  │               │
   │                 │                │                │               │
   │                 │                │                │ Verify sig    │
   │                 │                │                │ Execute       │
   │                 │                │                │ transferWith  │
   │                 │                │                │ Authorization │
   │                 │                │                │ on-chain      │
   │                 │                │                │               │
   │                 │                │                │ settle_x402_  │
   │                 │                │                │ credit_       │
   │                 │                │                │ purchase()    │
   │                 │                │                │──────────────>│
   │                 │                │                │              │
   │                 │                │                │  { tx_id }   │
   │                 │                │                │<─────────────│
   │                 │                │                │               │
   │  { success, credits, txId }     │                │               │
   │<──────────────────────────────────────────────── │               │
```
