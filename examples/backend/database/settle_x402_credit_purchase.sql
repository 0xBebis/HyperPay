-- ============================================================================
-- settle_x402_credit_purchase — Atomic Payment Settlement
-- ============================================================================
-- Called by the billing controller after an X402 (EIP-3009) or CCTP payment
-- has been verified. Atomically:
--   1. Inserts a billing_transactions record (idempotent via partial unique index)
--   2. Updates or inserts the user's credit balance
--
-- The same function structure is used for both X402 and CCTP payments —
-- settle_cctp_credit_purchase is identical but with payment_provider = 'cctp'.
--
-- Idempotency: If the same provider_charge_id + payment_provider combination
-- already exists, the INSERT is skipped (ON CONFLICT DO NOTHING) and the
-- existing completed transaction is returned. This makes retries safe.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.settle_x402_credit_purchase(
    p_account_id uuid,
    p_provider_charge_id text,
    p_amount numeric,
    p_credits integer,
    p_credit_package_id text
) RETURNS public.billing_transactions
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_tx billing_transactions;
BEGIN
  -- 1. Insert transaction (idempotent via partial unique index)
  INSERT INTO billing_transactions (
    account_id,
    provider_charge_id,
    payment_provider,
    amount,
    credits_purchased,
    discount_applied,
    credit_package_id,
    type,
    status
  )
  VALUES (
    p_account_id,
    p_provider_charge_id,
    'x402',
    p_amount,
    p_credits,
    0,
    p_credit_package_id,
    'credit_purchase',
    'completed'
  )
  ON CONFLICT (provider_charge_id, payment_provider)
    WHERE provider_charge_id IS NOT NULL
      AND payment_provider = 'x402'
  DO NOTHING
  RETURNING * INTO v_tx;

  -- Handle conflict: fetch existing completed transaction
  IF v_tx.id IS NULL THEN
    SELECT *
    INTO v_tx
    FROM billing_transactions
    WHERE provider_charge_id = p_provider_charge_id
      AND payment_provider = 'x402'
      AND status = 'completed';

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Transaction exists for x402 charge % but status is not completed', p_provider_charge_id;
    END IF;
  END IF;

  -- 2. Apply credits (idempotent — upsert with atomic increment)
  INSERT INTO credit_balances (account_id, balance)
  VALUES (p_account_id, p_credits)
  ON CONFLICT (account_id)
  DO UPDATE SET
    balance    = credit_balances.balance + EXCLUDED.balance,
    updated_at = now();

  RETURN v_tx;
END;
$$;


-- ============================================================================
-- settle_cctp_credit_purchase — Same structure for CCTP payments
-- ============================================================================
-- The charge ID format for CCTP is: "{account_address}={hl_nonce}"
-- This ensures uniqueness per CCTP transfer and enables nonce-based ordering.

CREATE OR REPLACE FUNCTION public.settle_cctp_credit_purchase(
    p_account_id uuid,
    p_provider_charge_id text,
    p_amount numeric,
    p_credits integer,
    p_credit_package_id text
) RETURNS public.billing_transactions
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_tx billing_transactions;
BEGIN
  INSERT INTO billing_transactions (
    account_id,
    provider_charge_id,
    payment_provider,
    amount,
    credits_purchased,
    discount_applied,
    credit_package_id,
    type,
    status
  )
  VALUES (
    p_account_id,
    p_provider_charge_id,
    'cctp',
    p_amount,
    p_credits,
    0,
    p_credit_package_id,
    'credit_purchase',
    'completed'
  )
  ON CONFLICT (provider_charge_id, payment_provider)
    WHERE provider_charge_id IS NOT NULL
      AND payment_provider = 'cctp'
  DO NOTHING
  RETURNING * INTO v_tx;

  IF v_tx.id IS NULL THEN
    SELECT *
    INTO v_tx
    FROM billing_transactions
    WHERE provider_charge_id = p_provider_charge_id
      AND payment_provider = 'cctp'
      AND status = 'completed';

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Transaction exists for cctp charge % but status is not completed', p_provider_charge_id;
    END IF;
  END IF;

  INSERT INTO credit_balances (account_id, balance)
  VALUES (p_account_id, p_credits)
  ON CONFLICT (account_id)
  DO UPDATE SET
    balance    = credit_balances.balance + EXCLUDED.balance,
    updated_at = now();

  RETURN v_tx;
END;
$$;
