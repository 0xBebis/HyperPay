# Example Integration

These files show how the packages in `../packages/` are used in a production application — an AI agent trading platform with cross-chain billing.

**These are reference implementations, not runnable standalone code.** They import from the parent application's infrastructure (Supabase, shadcn/ui, wagmi, Moon SDK, BullMQ, etc.) which is not included here.

## What to look at

### Backend

| File | Shows |
|------|-------|
| `backend/controllers/billing.controller.ts` | CCTP credit purchase endpoint using `@cod3x/cctp-verify` for settlement verification |
| `backend/library/hl/` | Hyperliquid exchange wrapper with CCTP bridge via `sendToEvmWithData()` |
| `backend/queue/agent-funding.queue.ts` | Full 1825-line funding pipeline (BullMQ) — the production version before extraction to `@cod3x/funding-pipeline` |
| `backend/database/*.sql` | PostgreSQL atomic settlement functions and migration for multi-chain bridge support |

### Frontend

| File | Shows |
|------|-------|
| `frontend/components/x402/X402PaymentFlow.tsx` | Payment UI component consuming the `useX402Payment` hook |
| `frontend/components/billing/CreditPurchase.tsx` | Credit purchase page with X402 and Coinbase Commerce payment options |
| `frontend/hooks/x402/useX402Payment.ts` | React hook for EIP-3009 gasless signing (full version with Moon SDK agent support) |
| `frontend/hooks/funding/` | Real-time funding job tracking via Socket.IO |
| `frontend/types/x402.ts` | Standalone X402 protocol type definitions |

## Using the packages in your own app

Don't copy these example files. Instead, install the packages from `../packages/` and implement the provider interfaces for your own infrastructure. See the main [README](../README.md) for usage examples.
