-- Keep legacy orders unchanged; mark new orders created with sandbox keys.
ALTER TABLE public.qr_orders
  ADD COLUMN IF NOT EXISTS test_payment boolean NOT NULL DEFAULT false;
