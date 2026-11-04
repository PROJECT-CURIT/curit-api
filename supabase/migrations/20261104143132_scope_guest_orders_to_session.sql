-- Contact numbers are not proof of ownership. Existing orders stay intact
-- and cannot be claimed by opening a new session with the same number.
ALTER TABLE public.qr_orders
  ADD COLUMN IF NOT EXISTS customer_session_hash text;

CREATE INDEX IF NOT EXISTS qr_orders_guest_session_paid_idx
  ON public.qr_orders (customer_session_hash, created_at DESC)
  WHERE status = 'paid' AND customer_session_hash IS NOT NULL;
