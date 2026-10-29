CREATE TABLE IF NOT EXISTS qr_listings (
  id UUID PRIMARY KEY,
  qr_token_hash CHAR(64) UNIQUE NOT NULL,
  token_hint VARCHAR(12) NOT NULL,
  sale_status VARCHAR(16) NOT NULL CHECK (sale_status IN ('preparing', 'active')),
  price INTEGER NOT NULL CHECK (price > 0),
  stock INTEGER NOT NULL CHECK (stock >= 0),
  snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customer_sessions (
  token_hash CHAR(64) PRIMARY KEY,
  customer_phone VARCHAR(20) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS customer_sessions_expires_idx
  ON customer_sessions (expires_at);

CREATE TABLE IF NOT EXISTS qr_orders (
  id VARCHAR(64) PRIMARY KEY,
  listing_id UUID NOT NULL REFERENCES qr_listings(id),
  customer_name VARCHAR(40) NOT NULL,
  customer_phone VARCHAR(20) NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  amount INTEGER NOT NULL CHECK (amount > 0),
  status VARCHAR(20) NOT NULL CHECK (status IN ('pending', 'paid', 'cancelled')),
  simulated BOOLEAN NOT NULL DEFAULT FALSE,
  payment_method VARCHAR(80) NOT NULL,
  pickup_mode VARCHAR(20) NOT NULL CHECK (pickup_mode IN ('immediate', 'exhibition')),
  pickup_date VARCHAR(10) NOT NULL DEFAULT '',
  cafe_name VARCHAR(120) NOT NULL,
  cafe_phone VARCHAR(30) NOT NULL,
  snapshot JSONB NOT NULL,
  store_id VARCHAR(120) NOT NULL,
  request_id VARCHAR(120) NOT NULL,
  artwork_id VARCHAR(120) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS qr_orders_customer_created_idx
  ON qr_orders (customer_phone, created_at DESC);

CREATE INDEX IF NOT EXISTS qr_orders_listing_created_idx
  ON qr_orders (listing_id, created_at DESC);
