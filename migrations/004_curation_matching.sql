-- AI 큐레이션 대화, 설명 가능한 추천 이력, 양방향 협업 제안/대화

CREATE TABLE IF NOT EXISTS public.curator_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('creator', 'store')),
  title TEXT NOT NULL DEFAULT 'CURI:T AI 큐레이터',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, role)
);

CREATE TABLE IF NOT EXISTS public.curator_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES public.curator_threads(id) ON DELETE CASCADE,
  sender TEXT NOT NULL CHECK (sender IN ('user', 'assistant')),
  content TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 4000),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS curator_messages_thread_created_idx
  ON public.curator_messages (thread_id, created_at);

CREATE TABLE IF NOT EXISTS public.collaboration_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collaboration_id UUID NOT NULL REFERENCES public.collaborations(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  content TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS collaboration_messages_collaboration_created_idx
  ON public.collaboration_messages (collaboration_id, created_at);

DROP TRIGGER IF EXISTS curator_threads_set_updated_at ON public.curator_threads;
CREATE TRIGGER curator_threads_set_updated_at BEFORE UPDATE ON public.curator_threads
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.curator_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.curator_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.collaboration_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS curator_threads_owner_all ON public.curator_threads;
CREATE POLICY curator_threads_owner_all ON public.curator_threads FOR ALL TO authenticated
USING (user_id = (SELECT auth.uid()))
WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS curator_messages_owner_read ON public.curator_messages;
CREATE POLICY curator_messages_owner_read ON public.curator_messages FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.curator_threads t
  WHERE t.id = thread_id AND t.user_id = (SELECT auth.uid())
));

DROP POLICY IF EXISTS curator_messages_owner_insert ON public.curator_messages;
CREATE POLICY curator_messages_owner_insert ON public.curator_messages FOR INSERT TO authenticated
WITH CHECK (EXISTS (
  SELECT 1 FROM public.curator_threads t
  WHERE t.id = thread_id AND t.user_id = (SELECT auth.uid())
));

DROP POLICY IF EXISTS collaboration_messages_participant_read ON public.collaboration_messages;
CREATE POLICY collaboration_messages_participant_read ON public.collaboration_messages FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.collaborations c
  WHERE c.id = collaboration_id
    AND (
      c.creator_id = (SELECT auth.uid())
      OR EXISTS (
        SELECT 1 FROM public.store_profiles s
        WHERE s.id = c.store_id AND s.owner_id = (SELECT auth.uid())
      )
    )
));

DROP POLICY IF EXISTS collaboration_messages_participant_insert ON public.collaboration_messages;
CREATE POLICY collaboration_messages_participant_insert ON public.collaboration_messages FOR INSERT TO authenticated
WITH CHECK (
  sender_id = (SELECT auth.uid())
  AND EXISTS (
    SELECT 1 FROM public.collaborations c
    WHERE c.id = collaboration_id
      AND (
        c.creator_id = (SELECT auth.uid())
        OR EXISTS (
          SELECT 1 FROM public.store_profiles s
          WHERE s.id = c.store_id AND s.owner_id = (SELECT auth.uid())
        )
      )
  )
);

CREATE OR REPLACE FUNCTION public.create_curit_proposal(
  p_target_id UUID,
  p_target_kind TEXT,
  p_message TEXT DEFAULT '',
  p_starts_on DATE DEFAULT (CURRENT_DATE + 7),
  p_ends_on DATE DEFAULT (CURRENT_DATE + 97)
)
RETURNS public.collaborations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_role TEXT;
  selected_project public.projects;
  selected_store public.store_profiles;
  result public.collaborations;
BEGIN
  SELECT role INTO actor_role FROM public.profiles WHERE id = auth.uid();
  IF actor_role IS NULL THEN RAISE EXCEPTION 'PROFILE_NOT_FOUND'; END IF;
  IF p_ends_on <= p_starts_on THEN RAISE EXCEPTION 'INVALID_EXHIBITION_DATES'; END IF;

  IF actor_role = 'store' AND p_target_kind = 'project' THEN
    SELECT * INTO selected_store FROM public.store_profiles WHERE owner_id = auth.uid();
    SELECT * INTO selected_project FROM public.projects WHERE id = p_target_id AND status <> 'archived';
  ELSIF actor_role = 'creator' AND p_target_kind = 'store' THEN
    SELECT * INTO selected_store FROM public.store_profiles WHERE id = p_target_id AND onboarding_complete = TRUE;
    SELECT * INTO selected_project FROM public.projects
      WHERE creator_id = auth.uid() AND status <> 'archived'
      ORDER BY updated_at DESC LIMIT 1;
  ELSE
    RAISE EXCEPTION 'INVALID_PROPOSAL_TARGET';
  END IF;

  IF selected_store.id IS NULL OR selected_project.id IS NULL THEN
    RAISE EXCEPTION 'PROPOSAL_TARGET_NOT_FOUND';
  END IF;

  INSERT INTO public.collaborations (
    project_id, store_id, creator_id, status, starts_on, ends_on, terms
  ) VALUES (
    selected_project.id,
    selected_store.id,
    selected_project.creator_id,
    'proposed',
    p_starts_on,
    p_ends_on,
    jsonb_build_object(
      'initiatedBy', actor_role,
      'message', left(trim(p_message), 1000),
      'proposalCreatedAt', NOW()
    )
  )
  ON CONFLICT (project_id, store_id) DO UPDATE SET
    status = CASE
      WHEN public.collaborations.status IN ('active', 'completed') THEN public.collaborations.status
      ELSE 'proposed'
    END,
    starts_on = EXCLUDED.starts_on,
    ends_on = EXCLUDED.ends_on,
    terms = public.collaborations.terms || EXCLUDED.terms,
    updated_at = NOW()
  RETURNING * INTO result;

  IF result.status = 'proposed' AND trim(p_message) <> '' THEN
    INSERT INTO public.collaboration_messages (collaboration_id, sender_id, content)
    VALUES (result.id, auth.uid(), left(trim(p_message), 2000));
  END IF;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.transition_curit_collaboration(
  p_collaboration_id UUID,
  p_action TEXT,
  p_message TEXT DEFAULT ''
)
RETURNS public.collaborations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_role TEXT;
  selected public.collaborations;
  next_status TEXT;
BEGIN
  SELECT p.role INTO actor_role FROM public.profiles p WHERE p.id = auth.uid();
  SELECT c.* INTO selected
  FROM public.collaborations c
  LEFT JOIN public.store_profiles s ON s.id = c.store_id
  WHERE c.id = p_collaboration_id
    AND (c.creator_id = auth.uid() OR s.owner_id = auth.uid())
  FOR UPDATE OF c;

  IF selected.id IS NULL THEN RAISE EXCEPTION 'COLLABORATION_NOT_FOUND'; END IF;

  IF actor_role = 'creator' AND p_action = 'accept' AND selected.status IN ('proposed', 'negotiating') THEN
    next_status := 'approved';
  ELSIF actor_role = 'store' AND p_action = 'confirm' AND selected.status = 'approved' THEN
    next_status := 'active';
  ELSIF p_action = 'counter' AND selected.status IN ('proposed', 'negotiating', 'approved') THEN
    next_status := 'negotiating';
  ELSIF p_action = 'cancel' AND selected.status NOT IN ('completed', 'cancelled') THEN
    next_status := 'cancelled';
  ELSIF p_action = 'complete' AND selected.status = 'active' THEN
    next_status := 'completed';
  ELSE
    RAISE EXCEPTION 'INVALID_COLLABORATION_TRANSITION';
  END IF;

  UPDATE public.collaborations
  SET status = next_status,
      terms = terms || jsonb_build_object('lastAction', p_action, 'lastActionBy', actor_role, 'lastActionAt', NOW()),
      updated_at = NOW()
  WHERE id = selected.id
  RETURNING * INTO selected;

  IF trim(p_message) <> '' THEN
    INSERT INTO public.collaboration_messages (collaboration_id, sender_id, content)
    VALUES (selected.id, auth.uid(), left(trim(p_message), 2000));
  END IF;
  RETURN selected;
END;
$$;

REVOKE ALL ON FUNCTION public.create_curit_proposal(UUID, TEXT, TEXT, DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_curit_proposal(UUID, TEXT, TEXT, DATE, DATE) TO authenticated;
REVOKE ALL ON FUNCTION public.transition_curit_collaboration(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transition_curit_collaboration(UUID, TEXT, TEXT) TO authenticated;

GRANT SELECT, INSERT, UPDATE ON public.curator_threads TO authenticated;
GRANT SELECT, INSERT ON public.curator_messages, public.collaboration_messages TO authenticated;
