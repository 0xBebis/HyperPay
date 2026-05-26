-- ============================================================================
-- Funding: multi-chain USDC deposit detection + CCTP bridge to Arbitrum
-- ----------------------------------------------------------------------------
-- Before: the queue polled only the agent wallet's Arbitrum balance.
-- Users who happened to have USDC on other chains had to bridge to Arbitrum
-- themselves before starting funding.
--
-- After: the queue polls the same wallet address on all CCTP-supported chains
-- in parallel. If a USDC deposit lands on a non-Arbitrum chain, the pipeline
-- transitions through a `bridging` state that uses Circle CCTP to bridge
-- USDC to Arbitrum (burn → attestation → mint), then continues with the
-- credits → exchange deposit flow.
--
-- Supported chains: Ethereum, Avalanche, Optimism, Arbitrum, Noble, Solana,
-- Base, Polygon PoS, Sui, and Hypercore (Hyperliquid).
-- ============================================================================

-- ── New state: bridging ──
ALTER TABLE public.agent_funding_jobs
  DROP CONSTRAINT agent_funding_jobs_state_check;

ALTER TABLE public.agent_funding_jobs
  ADD CONSTRAINT agent_funding_jobs_state_check CHECK (
    state = ANY (ARRAY[
      'waiting_deposit'::text,
      'bridging'::text,
      'buying_credits'::text,
      'confirming_credits'::text,
      'granting_credits'::text,
      'depositing_exchange'::text,
      'complete'::text,
      'failed'::text,
      'cancelled'::text
    ])
  );

-- ── Columns for CCTP bridge tracking ──

-- Chain ID where the user's USDC deposit was detected.
-- "42161" means the deposit arrived directly on Arbitrum — no bridge needed.
ALTER TABLE public.agent_funding_jobs
  ADD COLUMN IF NOT EXISTS source_chain_id text;

-- CCTP burn tx hash on the source chain. Used to:
--   - resume the attestation wait on retry without re-broadcasting
--   - track the burn in Circle's attestation API
ALTER TABLE public.agent_funding_jobs
  ADD COLUMN IF NOT EXISTS burn_tx_hash text;

-- CCTP mint tx hash on the destination chain (Arbitrum).
-- Set when MessageTransmitter.receiveMessage() is confirmed.
ALTER TABLE public.agent_funding_jobs
  ADD COLUMN IF NOT EXISTS mint_tx_hash text;

-- Circle attestation and message bytes (cached for idempotent retries).
ALTER TABLE public.agent_funding_jobs
  ADD COLUMN IF NOT EXISTS cctp_attestation text;

ALTER TABLE public.agent_funding_jobs
  ADD COLUMN IF NOT EXISTS cctp_message text;

-- Per-chain initial USDC balance snapshot. JSONB map:
-- { "1": "1000000", "42161": "25000000", "999": "50000000" }
-- Values are USDC amounts in atomic units (6 decimals) as strings.
-- Snapshotted once when the worker first enters waiting_deposit.
ALTER TABLE public.agent_funding_jobs
  ADD COLUMN IF NOT EXISTS initial_balances_by_chain jsonb;
