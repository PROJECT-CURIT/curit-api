-- Figma Make 전체 화면을 실제 기능으로 연결하기 위한 프로필, 프로젝트,
-- 협업 상품, 소셜, 알림, 현장 수령 데이터 모델

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS activity_verified BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.creator_profiles
  ADD COLUMN IF NOT EXISTS headline TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS dna_moods TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS dna_colors TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS preferred_spaces TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS collaboration_goals TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS install_conditions TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS onboarding_step SMALLINT NOT NULL DEFAULT 1 CHECK (onboarding_step BETWEEN 1 AND 2),
  ADD COLUMN IF NOT EXISTS onboarding_complete BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS cover_path TEXT,
  ADD COLUMN IF NOT EXISTS creator_share_percent NUMERIC(5,2) NOT NULL DEFAULT 80
    CHECK (creator_share_percent BETWEEN 0 AND 100);

ALTER TABLE public.project_items
  ADD COLUMN IF NOT EXISTS pickup_mode TEXT NOT NULL DEFAULT 'immediate'
    CHECK (pickup_mode IN ('immediate', 'exhibition')),
  ADD COLUMN IF NOT EXISTS care TEXT NOT NULL DEFAULT '';

ALTER TABLE public.qr_orders
  ADD COLUMN IF NOT EXISTS fulfillment_status TEXT NOT NULL DEFAULT 'awaiting_pickup'
    CHECK (fulfillment_status IN ('awaiting_pickup', 'reserved', 'delivered')),
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS public.collaboration_items (
  collaboration_id UUID NOT NULL REFERENCES public.collaborations(id) ON DELETE CASCADE,
  project_item_id UUID NOT NULL REFERENCES public.project_items(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 100000),
  creator_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (collaboration_id, project_item_id)
);

CREATE TABLE IF NOT EXISTS public.creator_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  content TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 2000),
  image_path TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.creator_follows (
  follower_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  creator_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (follower_id, creator_id),
  CHECK (follower_id <> creator_id)
);

CREATE TABLE IF NOT EXISTS public.post_likes (
  post_id UUID NOT NULL REFERENCES public.creator_posts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.post_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID NOT NULL REFERENCES public.creator_posts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  content TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  body TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'general',
  entity_id UUID,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS creator_posts_created_idx ON public.creator_posts (created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_user_created_idx ON public.notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS qr_orders_fulfillment_idx ON public.qr_orders (fulfillment_status, created_at DESC);

DROP TRIGGER IF EXISTS collaboration_items_set_updated_at ON public.collaboration_items;
CREATE TRIGGER collaboration_items_set_updated_at BEFORE UPDATE ON public.collaboration_items
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS creator_posts_set_updated_at ON public.creator_posts;
CREATE TRIGGER creator_posts_set_updated_at BEFORE UPDATE ON public.creator_posts
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.collaboration_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.creator_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.creator_follows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS profiles_update_self ON public.profiles;
CREATE POLICY profiles_update_self ON public.profiles FOR UPDATE TO authenticated
USING (id = (SELECT auth.uid())) WITH CHECK (id = (SELECT auth.uid()));

DROP POLICY IF EXISTS collaboration_items_participant_read ON public.collaboration_items;
CREATE POLICY collaboration_items_participant_read ON public.collaboration_items FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.collaborations c
  LEFT JOIN public.store_profiles s ON s.id = c.store_id
  WHERE c.id = collaboration_id AND (c.creator_id = (SELECT auth.uid()) OR s.owner_id = (SELECT auth.uid()))
));

DROP POLICY IF EXISTS creator_posts_read_authenticated ON public.creator_posts;
CREATE POLICY creator_posts_read_authenticated ON public.creator_posts FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS creator_posts_owner_insert ON public.creator_posts;
CREATE POLICY creator_posts_owner_insert ON public.creator_posts FOR INSERT TO authenticated
WITH CHECK (
  creator_id = (SELECT auth.uid())
  AND EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = (SELECT auth.uid()) AND p.role = 'creator'
  )
);
DROP POLICY IF EXISTS creator_posts_owner_update ON public.creator_posts;
CREATE POLICY creator_posts_owner_update ON public.creator_posts FOR UPDATE TO authenticated
USING (creator_id = (SELECT auth.uid())) WITH CHECK (creator_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS creator_posts_owner_delete ON public.creator_posts;
CREATE POLICY creator_posts_owner_delete ON public.creator_posts FOR DELETE TO authenticated
USING (creator_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS creator_follows_read_authenticated ON public.creator_follows;
CREATE POLICY creator_follows_read_authenticated ON public.creator_follows FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS creator_follows_self_insert ON public.creator_follows;
CREATE POLICY creator_follows_self_insert ON public.creator_follows FOR INSERT TO authenticated
WITH CHECK (follower_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS creator_follows_self_delete ON public.creator_follows;
CREATE POLICY creator_follows_self_delete ON public.creator_follows FOR DELETE TO authenticated
USING (follower_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS post_likes_read_authenticated ON public.post_likes;
CREATE POLICY post_likes_read_authenticated ON public.post_likes FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS post_likes_self_insert ON public.post_likes;
CREATE POLICY post_likes_self_insert ON public.post_likes FOR INSERT TO authenticated
WITH CHECK (user_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS post_likes_self_delete ON public.post_likes;
CREATE POLICY post_likes_self_delete ON public.post_likes FOR DELETE TO authenticated
USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS post_comments_read_authenticated ON public.post_comments;
CREATE POLICY post_comments_read_authenticated ON public.post_comments FOR SELECT TO authenticated USING (TRUE);
DROP POLICY IF EXISTS post_comments_self_insert ON public.post_comments;
CREATE POLICY post_comments_self_insert ON public.post_comments FOR INSERT TO authenticated
WITH CHECK (user_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS post_comments_self_delete ON public.post_comments;
CREATE POLICY post_comments_self_delete ON public.post_comments FOR DELETE TO authenticated
USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS notifications_owner_read ON public.notifications;
CREATE POLICY notifications_owner_read ON public.notifications FOR SELECT TO authenticated
USING (user_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS notifications_owner_update ON public.notifications;
CREATE POLICY notifications_owner_update ON public.notifications FOR UPDATE TO authenticated
USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));

CREATE OR REPLACE FUNCTION public.save_curit_collaboration_terms(
  p_collaboration_id UUID,
  p_terms JSONB DEFAULT '{}'::jsonb,
  p_items JSONB DEFAULT '[]'::jsonb
)
RETURNS public.collaborations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  selected public.collaborations;
  item JSONB;
BEGIN
  SELECT c.* INTO selected
  FROM public.collaborations c
  LEFT JOIN public.store_profiles s ON s.id = c.store_id
  WHERE c.id = p_collaboration_id
    AND (c.creator_id = auth.uid() OR s.owner_id = auth.uid())
  FOR UPDATE OF c;
  IF selected.id IS NULL THEN RAISE EXCEPTION 'COLLABORATION_NOT_FOUND'; END IF;
  IF selected.status IN ('completed', 'cancelled') THEN RAISE EXCEPTION 'COLLABORATION_CLOSED'; END IF;

  UPDATE public.collaborations
  SET terms = terms || COALESCE(p_terms, '{}'::jsonb), updated_at = NOW()
  WHERE id = selected.id RETURNING * INTO selected;

  FOR item IN SELECT * FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) LOOP
    IF EXISTS (
      SELECT 1 FROM public.project_items pi
      WHERE pi.id = (item ->> 'projectItemId')::uuid AND pi.project_id = selected.project_id
    ) THEN
      INSERT INTO public.collaboration_items (collaboration_id, project_item_id, quantity, creator_confirmed)
      VALUES (
        selected.id,
        (item ->> 'projectItemId')::uuid,
        GREATEST(1, LEAST(100000, COALESCE((item ->> 'quantity')::integer, 1))),
        COALESCE((item ->> 'creatorConfirmed')::boolean, FALSE)
      )
      ON CONFLICT (collaboration_id, project_item_id) DO UPDATE SET
        quantity = EXCLUDED.quantity,
        creator_confirmed = EXCLUDED.creator_confirmed,
        updated_at = NOW();
    END IF;
  END LOOP;
  RETURN selected;
END;
$$;

CREATE OR REPLACE FUNCTION public.notify_curit_collaboration_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE store_owner UUID;
BEGIN
  SELECT owner_id INTO store_owner FROM public.store_profiles WHERE id = NEW.store_id;
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.notifications (user_id, title, body, kind, entity_id)
    VALUES
      (NEW.creator_id, '새 협업 제안이 도착했어요', '상품과 전시 조건을 확인해 주세요.', 'collaboration', NEW.id),
      (store_owner, '협업 제안을 보냈어요', '크리에이터의 답변을 기다리고 있습니다.', 'collaboration', NEW.id);
  ELSIF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO public.notifications (user_id, title, body, kind, entity_id)
    VALUES
      (NEW.creator_id, '협업 상태가 변경됐어요', '현재 상태: ' || NEW.status, 'collaboration', NEW.id),
      (store_owner, '협업 상태가 변경됐어요', '현재 상태: ' || NEW.status, 'collaboration', NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS collaborations_notify_change ON public.collaborations;
CREATE TRIGGER collaborations_notify_change AFTER INSERT OR UPDATE OF status ON public.collaborations
FOR EACH ROW EXECUTE FUNCTION public.notify_curit_collaboration_change();

REVOKE ALL ON FUNCTION public.save_curit_collaboration_terms(UUID, JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_curit_collaboration_terms(UUID, JSONB, JSONB) TO authenticated;

-- Trigger-only SECURITY DEFINER functions are not public RPC endpoints.
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO supabase_auth_admin;
REVOKE ALL ON FUNCTION public.notify_curit_collaboration_change() FROM PUBLIC, anon, authenticated;

REVOKE UPDATE ON TABLE public.profiles FROM authenticated;
GRANT UPDATE (display_name, handle, avatar_path) ON TABLE public.profiles TO authenticated;
GRANT SELECT ON public.collaboration_items, public.creator_posts, public.creator_follows, public.post_likes, public.post_comments, public.notifications TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.creator_posts TO authenticated;
GRANT INSERT, DELETE ON public.creator_follows, public.post_likes, public.post_comments TO authenticated;
GRANT UPDATE ON public.notifications TO authenticated;

UPDATE public.creator_profiles cp
SET onboarding_complete = TRUE, onboarding_step = 2
WHERE EXISTS (SELECT 1 FROM public.projects p WHERE p.creator_id = cp.user_id)
   OR cardinality(cp.categories) > 0;

UPDATE public.qr_orders
SET fulfillment_status = CASE
  WHEN status = 'paid' THEN 'awaiting_pickup'
  ELSE fulfillment_status
END;
