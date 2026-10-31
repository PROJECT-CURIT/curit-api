-- Privacy-preserving QR performance analytics.
-- One anonymous browser is counted at most once per listing and calendar day.

ALTER TABLE qr_listings
  ADD COLUMN IF NOT EXISTS view_count BIGINT NOT NULL DEFAULT 0
    CHECK (view_count >= 0);

CREATE TABLE IF NOT EXISTS qr_view_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES qr_listings(id) ON DELETE CASCADE,
  visitor_hash CHAR(64) NOT NULL,
  viewed_on DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (listing_id, visitor_hash, viewed_on)
);

CREATE INDEX IF NOT EXISTS qr_view_events_listing_date_idx
  ON qr_view_events (listing_id, viewed_on DESC);

CREATE OR REPLACE FUNCTION increment_qr_listing_view_count()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE qr_listings
  SET view_count = view_count + 1,
      updated_at = NOW()
  WHERE id = NEW.listing_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS qr_view_events_increment_count ON qr_view_events;
CREATE TRIGGER qr_view_events_increment_count
AFTER INSERT ON qr_view_events
FOR EACH ROW EXECUTE FUNCTION increment_qr_listing_view_count();
