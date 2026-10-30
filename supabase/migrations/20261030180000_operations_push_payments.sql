-- Native push delivery, payment cancellation/webhook reconciliation and payout ledgers.

ALTER TABLE public.qr_orders
  ADD COLUMN IF NOT EXISTS provider_status TEXT,
  ADD COLUMN IF NOT EXISTS cancelled_amount INTEGER NOT NULL DEFAULT 0 CHECK (cancelled_amount >= 0),
  ADD COLUMN IF NOT EXISTS cancel_reason TEXT,
  ADD COLUMN IF NOT EXISTS cancel_transaction_key TEXT,
  ADD COLUMN IF NOT EXISTS webhook_updated_at TIMESTAMPTZ,
  ADD CONSTRAINT qr_orders_cancelled_amount_lte_amount
    CHECK (cancelled_amount <= amount) NOT VALID;

ALTER TABLE public.qr_orders VALIDATE CONSTRAINT qr_orders_cancelled_amount_lte_amount;

CREATE TABLE IF NOT EXISTS public.payment_cancellations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id TEXT NOT NULL REFERENCES public.qr_orders(id) ON DELETE CASCADE,
  provider_transaction_key TEXT,
  provider_cancel_request_id TEXT,
  amount INTEGER NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'in_progress', 'completed', 'failed')),
  provider_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE (order_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS payment_cancellations_transaction_unique
  ON public.payment_cancellations (provider_transaction_key)
  WHERE provider_transaction_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.toss_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  transmission_id TEXT,
  payload JSONB NOT NULL,
  processing_status TEXT NOT NULL DEFAULT 'processing' CHECK (processing_status IN ('processing', 'processed', 'ignored', 'failed')),
  error_message TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS toss_webhook_events_received_idx
  ON public.toss_webhook_events (received_at DESC);

CREATE TABLE IF NOT EXISTS public.push_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  expo_push_token TEXT NOT NULL CHECK (char_length(expo_push_token) BETWEEN 20 AND 255),
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  device_name TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, expo_push_token)
);

CREATE INDEX IF NOT EXISTS push_devices_user_active_idx
  ON public.push_devices (user_id, active);

CREATE TABLE IF NOT EXISTS public.push_delivery_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id UUID REFERENCES public.notifications(id) ON DELETE SET NULL,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  push_device_id UUID REFERENCES public.push_devices(id) ON DELETE SET NULL,
  provider_ticket_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'error')),
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS push_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (push_status IN ('pending', 'processing', 'sent', 'failed', 'skipped')),
  ADD COLUMN IF NOT EXISTS push_attempted_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS public.payout_sellers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE CASCADE,
  provider_seller_id TEXT NOT NULL UNIQUE,
  ref_seller_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('APPROVAL_REQUIRED', 'PARTIALLY_APPROVED', 'KYC_REQUIRED', 'APPROVED', 'DISABLED')),
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.payout_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_entry_id UUID NOT NULL REFERENCES public.settlement_entries(id) ON DELETE RESTRICT,
  beneficiary_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  beneficiary_type TEXT NOT NULL CHECK (beneficiary_type IN ('creator', 'store')),
  seller_id UUID NOT NULL REFERENCES public.payout_sellers(id) ON DELETE RESTRICT,
  ref_payout_id TEXT NOT NULL UNIQUE,
  provider_payout_id TEXT UNIQUE,
  amount INTEGER NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'requested', 'in_progress', 'completed', 'failed', 'cancelled', 'held')),
  provider_error JSONB,
  requested_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (settlement_entry_id, beneficiary_type)
);

CREATE INDEX IF NOT EXISTS payout_requests_beneficiary_created_idx
  ON public.payout_requests (beneficiary_id, created_at DESC);

ALTER TABLE public.payment_cancellations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.toss_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_delivery_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payout_sellers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payout_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS push_devices_owner_all ON public.push_devices;
CREATE POLICY push_devices_owner_all ON public.push_devices
  FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS payout_sellers_owner_read ON public.payout_sellers;
CREATE POLICY payout_sellers_owner_read ON public.payout_sellers
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS payout_requests_beneficiary_read ON public.payout_requests;
CREATE POLICY payout_requests_beneficiary_read ON public.payout_requests
  FOR SELECT TO authenticated
  USING (beneficiary_id = (SELECT auth.uid()));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.push_devices TO authenticated;
GRANT SELECT ON public.payout_sellers, public.payout_requests TO authenticated;

CREATE OR REPLACE FUNCTION public.cancel_curit_order(
  p_order_id TEXT,
  p_reason TEXT,
  p_provider_status TEXT DEFAULT 'CANCELED',
  p_transaction_key TEXT DEFAULT NULL
)
RETURNS public.qr_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  selected_order public.qr_orders;
  selected_settlement public.settlement_entries;
  cancelled_order public.qr_orders;
  collaboration_id UUID;
  creator_user UUID;
  store_user UUID;
BEGIN
  SELECT * INTO selected_order
  FROM public.qr_orders
  WHERE id = p_order_id
  FOR UPDATE;

  IF selected_order.id IS NULL THEN RAISE EXCEPTION 'ORDER_NOT_FOUND'; END IF;
  IF selected_order.status = 'cancelled' THEN RETURN selected_order; END IF;
  IF selected_order.status <> 'paid' THEN RAISE EXCEPTION 'ORDER_NOT_PAID'; END IF;
  IF selected_order.fulfillment_status = 'delivered' THEN RAISE EXCEPTION 'ORDER_ALREADY_DELIVERED'; END IF;

  SELECT * INTO selected_settlement
  FROM public.settlement_entries
  WHERE order_id = selected_order.id
  FOR UPDATE;

  IF selected_settlement.id IS NOT NULL AND selected_settlement.status = 'paid' THEN
    RAISE EXCEPTION 'SETTLEMENT_ALREADY_PAID';
  END IF;

  UPDATE public.qr_listings
  SET stock = stock + selected_order.quantity, updated_at = NOW()
  WHERE id = selected_order.listing_id;

  UPDATE public.qr_orders
  SET status = 'cancelled', cancelled_amount = amount, cancel_reason = left(p_reason, 200),
      cancel_transaction_key = p_transaction_key, provider_status = p_provider_status,
      cancelled_at = COALESCE(cancelled_at, NOW()), webhook_updated_at = NOW(), updated_at = NOW()
  WHERE id = selected_order.id
  RETURNING * INTO cancelled_order;

  UPDATE public.settlement_entries
  SET status = 'cancelled'
  WHERE order_id = selected_order.id AND status <> 'paid';

  SELECT l.collaboration_id, c.creator_id, s.owner_id
  INTO collaboration_id, creator_user, store_user
  FROM public.qr_listings l
  LEFT JOIN public.collaborations c ON c.id = l.collaboration_id
  LEFT JOIN public.store_profiles s ON s.id = c.store_id
  WHERE l.id = selected_order.listing_id;

  IF creator_user IS NOT NULL THEN
    INSERT INTO public.notifications (user_id, title, body, kind, entity_id)
    VALUES (creator_user, '주문이 취소됐어요', '주문 ' || right(selected_order.id, 8) || '의 결제와 정산 예정액이 취소됐습니다.', 'order', collaboration_id);
  END IF;
  IF store_user IS NOT NULL THEN
    INSERT INTO public.notifications (user_id, title, body, kind, entity_id)
    VALUES (store_user, '결제 취소가 완료됐어요', '주문 ' || right(selected_order.id, 8) || '의 재고가 다시 반영됐습니다.', 'order', collaboration_id);
  END IF;

  RETURN cancelled_order;
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_curit_order(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_curit_order(TEXT, TEXT, TEXT, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.prepare_curit_payouts(p_settlement_id UUID)
RETURNS SETOF public.payout_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE selected public.settlement_entries;
BEGIN
  SELECT * INTO selected FROM public.settlement_entries WHERE id = p_settlement_id FOR UPDATE;
  IF selected.id IS NULL THEN RAISE EXCEPTION 'SETTLEMENT_NOT_FOUND'; END IF;
  IF selected.status NOT IN ('scheduled', 'ready') THEN RAISE EXCEPTION 'SETTLEMENT_NOT_PAYABLE'; END IF;

  INSERT INTO public.payout_requests (
    settlement_entry_id, beneficiary_id, beneficiary_type, seller_id, ref_payout_id, amount, status
  )
  SELECT selected.id, selected.creator_id, 'creator', ps.id,
    'C' || replace(selected.id::text, '-', '') || '01', selected.creator_amount, 'ready'
  FROM public.payout_sellers ps
  WHERE ps.user_id = selected.creator_id AND ps.status IN ('PARTIALLY_APPROVED', 'APPROVED')
    AND selected.creator_amount > 0
  ON CONFLICT (settlement_entry_id, beneficiary_type) DO NOTHING;

  INSERT INTO public.payout_requests (
    settlement_entry_id, beneficiary_id, beneficiary_type, seller_id, ref_payout_id, amount, status
  )
  SELECT selected.id, selected.store_owner_id, 'store', ps.id,
    'S' || replace(selected.id::text, '-', '') || '01', selected.store_amount, 'ready'
  FROM public.payout_sellers ps
  WHERE ps.user_id = selected.store_owner_id AND ps.status IN ('PARTIALLY_APPROVED', 'APPROVED')
    AND selected.store_amount > 0
  ON CONFLICT (settlement_entry_id, beneficiary_type) DO NOTHING;

  RETURN QUERY SELECT * FROM public.payout_requests WHERE settlement_entry_id = selected.id ORDER BY beneficiary_type;
END;
$$;

REVOKE ALL ON FUNCTION public.prepare_curit_payouts(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_curit_payouts(UUID) TO service_role;
