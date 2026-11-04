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

-- Privacy-preserving purchase-intent counts for QR listings and field-sale items.
-- A purchase intent means that the visitor opened the purchase screen. It is
-- deliberately separate from a paid order. One browser is counted at most
-- once per product and Korean calendar day.

CREATE TABLE IF NOT EXISTS public.qr_purchase_intent_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES public.qr_listings(id) ON DELETE CASCADE,
  visitor_hash CHAR(64) NOT NULL,
  intended_on DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (listing_id, visitor_hash, intended_on)
);

CREATE INDEX IF NOT EXISTS qr_purchase_intent_events_listing_date_idx
  ON public.qr_purchase_intent_events (listing_id, intended_on DESC);

ALTER TABLE public.qr_purchase_intent_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.qr_purchase_intent_events FROM anon, authenticated;
GRANT ALL ON public.qr_purchase_intent_events TO service_role;

CREATE TABLE IF NOT EXISTS public.field_product_purchase_intent_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id TEXT NOT NULL CHECK (
    product_id IN ('kendama', 'dango-keyring', 'octopus-keyring', 'poetry-postcards')
  ),
  visitor_hash CHAR(64) NOT NULL,
  intended_on DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (product_id, visitor_hash, intended_on)
);

CREATE INDEX IF NOT EXISTS field_product_purchase_intent_events_product_date_idx
  ON public.field_product_purchase_intent_events (product_id, intended_on DESC);

ALTER TABLE public.field_product_purchase_intent_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.field_product_purchase_intent_events FROM anon, authenticated;
GRANT ALL ON public.field_product_purchase_intent_events TO service_role;

ALTER TABLE public.field_product_view_events
  DROP CONSTRAINT IF EXISTS field_product_view_events_product_id_check,
  ADD CONSTRAINT field_product_view_events_product_id_check
    CHECK (product_id IN (
      'kendama', 'dango-keyring', 'octopus-keyring', 'poetry-postcards',
      'jjukkumi-keyring', 'tea-coaster'
    ));

ALTER TABLE public.field_product_purchase_intent_events
  DROP CONSTRAINT IF EXISTS field_product_purchase_intent_events_product_id_check,
  ADD CONSTRAINT field_product_purchase_intent_events_product_id_check
    CHECK (product_id IN (
      'kendama', 'dango-keyring', 'octopus-keyring', 'poetry-postcards',
      'jjukkumi-keyring', 'tea-coaster'
    ));
