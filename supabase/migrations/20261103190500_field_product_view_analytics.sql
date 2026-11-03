-- Anonymous, privacy-preserving interest counts for the four field-sale QR items.
-- One browser is counted at most once per product and Korean calendar day.

CREATE TABLE IF NOT EXISTS public.field_product_view_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id TEXT NOT NULL CHECK (
    product_id IN ('kendama', 'dango-keyring', 'octopus-keyring', 'poetry-postcards')
  ),
  visitor_hash CHAR(64) NOT NULL,
  viewed_on DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (product_id, visitor_hash, viewed_on)
);

CREATE INDEX IF NOT EXISTS field_product_view_events_product_date_idx
  ON public.field_product_view_events (product_id, viewed_on DESC);

ALTER TABLE public.field_product_view_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.field_product_view_events FROM anon, authenticated;
GRANT ALL ON public.field_product_view_events TO service_role;
