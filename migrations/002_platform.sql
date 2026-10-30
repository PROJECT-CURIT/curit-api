CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('creator', 'store')),
  display_name TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 60),
  handle TEXT,
  avatar_path TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS profiles_handle_unique
  ON public.profiles (lower(handle)) WHERE handle IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.creator_profiles (
  user_id UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  introduction TEXT NOT NULL DEFAULT '',
  categories TEXT[] NOT NULL DEFAULT '{}',
  regions TEXT[] NOT NULL DEFAULT '{}',
  portfolio_url TEXT,
  sns_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.store_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  category TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  introduction TEXT NOT NULL DEFAULT '',
  target_audience TEXT NOT NULL DEFAULT '',
  mood_tags TEXT[] NOT NULL DEFAULT '{}',
  purpose_tags TEXT[] NOT NULL DEFAULT '{}',
  monthly_budget_min INTEGER CHECK (monthly_budget_min IS NULL OR monthly_budget_min >= 0),
  monthly_budget_max INTEGER CHECK (
    monthly_budget_max IS NULL OR monthly_budget_max >= COALESCE(monthly_budget_min, 0)
  ),
  photo_paths TEXT[] NOT NULL DEFAULT '{}',
  exhibition_zones JSONB NOT NULL DEFAULT '[]'::jsonb,
  onboarding_step SMALLINT NOT NULL DEFAULT 1 CHECK (onboarding_step BETWEEN 1 AND 5),
  onboarding_complete BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
  story TEXT NOT NULL DEFAULT '',
  concept TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '',
  purpose TEXT NOT NULL DEFAULT '작품 판매',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'recruiting', 'matched', 'archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS projects_creator_updated_idx
  ON public.projects (creator_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.project_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  description TEXT NOT NULL DEFAULT '',
  item_type TEXT NOT NULL CHECK (item_type IN ('goods', 'artwork')),
  sale_mode TEXT NOT NULL CHECK (sale_mode IN ('display_sale', 'display_only')),
  price INTEGER NOT NULL CHECK (price > 0),
  stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  image_path TEXT,
  material TEXT NOT NULL DEFAULT '',
  width_mm INTEGER CHECK (width_mm IS NULL OR width_mm > 0),
  height_mm INTEGER CHECK (height_mm IS NULL OR height_mm > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS project_items_project_idx
  ON public.project_items (project_id, created_at);

CREATE TABLE IF NOT EXISTS public.collaborations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  store_id UUID NOT NULL REFERENCES public.store_profiles(id) ON DELETE CASCADE,
  creator_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (
    status IN ('proposed', 'negotiating', 'approved', 'active', 'completed', 'cancelled')
  ),
  starts_on DATE,
  ends_on DATE,
  creator_share_percent NUMERIC(5,2) NOT NULL DEFAULT 80 CHECK (creator_share_percent BETWEEN 0 AND 100),
  store_share_percent NUMERIC(5,2) NOT NULL DEFAULT 10 CHECK (store_share_percent BETWEEN 0 AND 100),
  platform_share_percent NUMERIC(5,2) NOT NULL DEFAULT 10 CHECK (platform_share_percent BETWEEN 0 AND 100),
  terms JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, store_id),
  CHECK (creator_share_percent + store_share_percent + platform_share_percent = 100)
);

CREATE TABLE IF NOT EXISTS public.settlement_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id TEXT NOT NULL,
  collaboration_id UUID REFERENCES public.collaborations(id) ON DELETE SET NULL,
  creator_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  store_owner_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  gross_amount INTEGER NOT NULL CHECK (gross_amount > 0),
  creator_amount INTEGER NOT NULL CHECK (creator_amount >= 0),
  store_amount INTEGER NOT NULL CHECK (store_amount >= 0),
  platform_amount INTEGER NOT NULL CHECK (platform_amount >= 0),
  payment_fee_amount INTEGER NOT NULL DEFAULT 0 CHECK (payment_fee_amount >= 0),
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'ready', 'paid', 'held', 'cancelled')),
  scheduled_for DATE,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (order_id),
  CHECK (creator_amount + store_amount + platform_amount + payment_fee_amount = gross_amount)
);

ALTER TABLE public.qr_listings
  ADD COLUMN IF NOT EXISTS project_item_id UUID REFERENCES public.project_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS collaboration_id UUID REFERENCES public.collaborations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS qr_token_value TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS qr_listings_token_value_unique
  ON public.qr_listings (qr_token_value) WHERE qr_token_value IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS qr_listings_collaboration_item_unique
  ON public.qr_listings (collaboration_id, project_item_id)
  WHERE collaboration_id IS NOT NULL AND project_item_id IS NOT NULL;

ALTER TABLE public.qr_orders
  ADD COLUMN IF NOT EXISTS payment_key TEXT,
  ADD COLUMN IF NOT EXISTS payment_provider TEXT NOT NULL DEFAULT 'demo',
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS qr_orders_status_created_idx
  ON public.qr_orders (status, created_at DESC);

DROP TRIGGER IF EXISTS profiles_set_updated_at ON public.profiles;
CREATE TRIGGER profiles_set_updated_at BEFORE UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS creator_profiles_set_updated_at ON public.creator_profiles;
CREATE TRIGGER creator_profiles_set_updated_at BEFORE UPDATE ON public.creator_profiles
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS store_profiles_set_updated_at ON public.store_profiles;
CREATE TRIGGER store_profiles_set_updated_at BEFORE UPDATE ON public.store_profiles
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS projects_set_updated_at ON public.projects;
CREATE TRIGGER projects_set_updated_at BEFORE UPDATE ON public.projects
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS project_items_set_updated_at ON public.project_items;
CREATE TRIGGER project_items_set_updated_at BEFORE UPDATE ON public.project_items
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS collaborations_set_updated_at ON public.collaborations;
CREATE TRIGGER collaborations_set_updated_at BEFORE UPDATE ON public.collaborations
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  requested_role TEXT;
  requested_name TEXT;
BEGIN
  requested_role := CASE
    WHEN NEW.raw_user_meta_data ->> 'role' = 'store' THEN 'store'
    ELSE 'creator'
  END;
  requested_name := COALESCE(NULLIF(trim(NEW.raw_user_meta_data ->> 'display_name'), ''), split_part(NEW.email, '@', 1), 'CURI:T 사용자');
  INSERT INTO public.profiles (id, role, display_name)
  VALUES (NEW.id, requested_role, left(requested_name, 60))
  ON CONFLICT (id) DO NOTHING;
  IF requested_role = 'creator' THEN
    INSERT INTO public.creator_profiles (user_id) VALUES (NEW.id)
    ON CONFLICT (user_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.creator_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.collaborations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settlement_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.qr_listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.qr_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS profiles_read_authenticated ON public.profiles;
CREATE POLICY profiles_read_authenticated ON public.profiles FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS profiles_insert_self ON public.profiles;
CREATE POLICY profiles_insert_self ON public.profiles FOR INSERT TO authenticated WITH CHECK (id = (SELECT auth.uid()));
DROP POLICY IF EXISTS creator_profiles_read_authenticated ON public.creator_profiles;
CREATE POLICY creator_profiles_read_authenticated ON public.creator_profiles FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS creator_profiles_insert_self ON public.creator_profiles;
CREATE POLICY creator_profiles_insert_self ON public.creator_profiles FOR INSERT TO authenticated WITH CHECK (user_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS creator_profiles_update_self ON public.creator_profiles;
CREATE POLICY creator_profiles_update_self ON public.creator_profiles FOR UPDATE TO authenticated
USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS stores_read_authenticated ON public.store_profiles;
CREATE POLICY stores_read_authenticated ON public.store_profiles FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS stores_insert_owner ON public.store_profiles;
CREATE POLICY stores_insert_owner ON public.store_profiles FOR INSERT TO authenticated WITH CHECK (owner_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS stores_update_owner ON public.store_profiles;
CREATE POLICY stores_update_owner ON public.store_profiles FOR UPDATE TO authenticated
USING (owner_id = (SELECT auth.uid())) WITH CHECK (owner_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS stores_delete_owner ON public.store_profiles;
CREATE POLICY stores_delete_owner ON public.store_profiles FOR DELETE TO authenticated USING (owner_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS projects_read_authenticated ON public.projects;
CREATE POLICY projects_read_authenticated ON public.projects FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS projects_insert_creator ON public.projects;
CREATE POLICY projects_insert_creator ON public.projects FOR INSERT TO authenticated
WITH CHECK (
  creator_id = (SELECT auth.uid())
  AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = (SELECT auth.uid()) AND p.role = 'creator')
);
DROP POLICY IF EXISTS projects_update_creator ON public.projects;
CREATE POLICY projects_update_creator ON public.projects FOR UPDATE TO authenticated
USING (creator_id = (SELECT auth.uid())) WITH CHECK (creator_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS projects_delete_creator ON public.projects;
CREATE POLICY projects_delete_creator ON public.projects FOR DELETE TO authenticated USING (creator_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS project_items_read_authenticated ON public.project_items;
CREATE POLICY project_items_read_authenticated ON public.project_items FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS project_items_insert_creator ON public.project_items;
CREATE POLICY project_items_insert_creator ON public.project_items FOR INSERT TO authenticated
WITH CHECK (EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_id AND p.creator_id = (SELECT auth.uid())));
DROP POLICY IF EXISTS project_items_update_creator ON public.project_items;
CREATE POLICY project_items_update_creator ON public.project_items FOR UPDATE TO authenticated
USING (EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_id AND p.creator_id = (SELECT auth.uid())))
WITH CHECK (EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_id AND p.creator_id = (SELECT auth.uid())));
DROP POLICY IF EXISTS project_items_delete_creator ON public.project_items;
CREATE POLICY project_items_delete_creator ON public.project_items FOR DELETE TO authenticated
USING (EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_id AND p.creator_id = (SELECT auth.uid())));

DROP POLICY IF EXISTS collaborations_participant_read ON public.collaborations;
CREATE POLICY collaborations_participant_read ON public.collaborations FOR SELECT TO authenticated
USING (
  creator_id = (SELECT auth.uid()) OR EXISTS (
    SELECT 1 FROM public.store_profiles s WHERE s.id = store_id AND s.owner_id = (SELECT auth.uid())
  )
);
DROP POLICY IF EXISTS settlements_participant_read ON public.settlement_entries;
CREATE POLICY settlements_participant_read ON public.settlement_entries FOR SELECT TO authenticated
USING (creator_id = (SELECT auth.uid()) OR store_owner_id = (SELECT auth.uid()));

CREATE OR REPLACE FUNCTION public.confirm_curit_order(
  p_order_id TEXT,
  p_customer_phone TEXT,
  p_payment_key TEXT
)
RETURNS public.qr_orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  selected_order public.qr_orders;
  paid_order public.qr_orders;
BEGIN
  SELECT * INTO selected_order
  FROM public.qr_orders
  WHERE id = p_order_id AND customer_phone = p_customer_phone
  FOR UPDATE;

  IF selected_order.id IS NULL THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND';
  END IF;
  IF selected_order.status = 'paid' THEN
    RETURN selected_order;
  END IF;
  IF selected_order.status <> 'pending' THEN
    RAISE EXCEPTION 'ORDER_NOT_PENDING';
  END IF;

  UPDATE public.qr_listings
  SET stock = stock - selected_order.quantity, updated_at = NOW()
  WHERE id = selected_order.listing_id
    AND sale_status = 'active'
    AND stock >= selected_order.quantity;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INSUFFICIENT_STOCK';
  END IF;

  UPDATE public.qr_orders
  SET status = 'paid', payment_key = p_payment_key, paid_at = NOW(), updated_at = NOW()
  WHERE id = selected_order.id
  RETURNING * INTO paid_order;

  INSERT INTO public.settlement_entries (
    order_id, collaboration_id, creator_id, store_owner_id, gross_amount,
    creator_amount, store_amount, platform_amount, payment_fee_amount, status, scheduled_for
  )
  SELECT paid_order.id, c.id, c.creator_id, s.owner_id, paid_order.amount,
    floor(paid_order.amount * c.creator_share_percent / 100)::integer,
    floor(paid_order.amount * c.store_share_percent / 100)::integer,
    paid_order.amount
      - floor(paid_order.amount * c.creator_share_percent / 100)::integer
      - floor(paid_order.amount * c.store_share_percent / 100)::integer,
    0, 'scheduled', (CURRENT_DATE + INTERVAL '14 days')::date
  FROM public.qr_listings l
  JOIN public.collaborations c ON c.id = l.collaboration_id
  JOIN public.store_profiles s ON s.id = c.store_id
  WHERE l.id = paid_order.listing_id
  ON CONFLICT (order_id) DO NOTHING;

  RETURN paid_order;
END;
$$;

REVOKE ALL ON FUNCTION public.confirm_curit_order(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_curit_order(TEXT, TEXT, TEXT) TO service_role;

REVOKE ALL ON public.qr_listings, public.customer_sessions, public.qr_orders, public.settlement_entries FROM anon, authenticated;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT SELECT, INSERT ON public.profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.creator_profiles, public.store_profiles, public.projects, public.project_items TO authenticated;
GRANT SELECT ON public.collaborations TO authenticated;
GRANT DELETE ON public.store_profiles, public.projects, public.project_items TO authenticated;
GRANT SELECT ON public.settlement_entries TO authenticated;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'curit-media',
  'curit-media',
  TRUE,
  5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS curit_media_insert_owner ON storage.objects;
CREATE POLICY curit_media_insert_owner ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'curit-media' AND (storage.foldername(name))[1] = (SELECT auth.uid())::text);
DROP POLICY IF EXISTS curit_media_update_owner ON storage.objects;
CREATE POLICY curit_media_update_owner ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'curit-media' AND owner_id = (SELECT auth.uid()::text))
WITH CHECK (bucket_id = 'curit-media' AND (storage.foldername(name))[1] = (SELECT auth.uid())::text);
DROP POLICY IF EXISTS curit_media_delete_owner ON storage.objects;
CREATE POLICY curit_media_delete_owner ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'curit-media' AND owner_id = (SELECT auth.uid()::text));
