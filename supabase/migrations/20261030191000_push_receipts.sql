ALTER TABLE public.push_delivery_logs
  DROP CONSTRAINT IF EXISTS push_delivery_logs_status_check;

ALTER TABLE public.push_delivery_logs
  ADD CONSTRAINT push_delivery_logs_status_check
    CHECK (status IN ('accepted', 'delivered', 'error')),
  ADD COLUMN IF NOT EXISTS checked_at TIMESTAMPTZ;
