-- Profile rows are created by the signup trigger. Clients may edit only
-- the public columns already granted to authenticated.
REVOKE INSERT ON public.profiles FROM PUBLIC, anon, authenticated;

ALTER POLICY creator_profiles_insert_self ON public.creator_profiles
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = (SELECT auth.uid()) AND role = 'creator'
    )
  );

ALTER POLICY stores_insert_owner ON public.store_profiles
  WITH CHECK (
    owner_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = (SELECT auth.uid()) AND role = 'store'
    )
  );

-- Owners can edit drafts, and existing collaborators retain access to their
-- project even if it is no longer shown in discovery.
ALTER POLICY projects_read_authenticated ON public.projects
  USING (
    creator_id = (SELECT auth.uid())
    OR status IN ('recruiting', 'matched')
    OR EXISTS (
      SELECT 1
      FROM public.collaborations c
      JOIN public.store_profiles s ON s.id = c.store_id
      WHERE c.project_id = projects.id AND s.owner_id = (SELECT auth.uid())
    )
  );

ALTER POLICY project_items_read_authenticated ON public.project_items
  USING (
    EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_items.project_id)
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
  initial_status TEXT;
BEGIN
  SELECT role INTO actor_role FROM public.profiles WHERE id = auth.uid();
  IF actor_role IS NULL THEN RAISE EXCEPTION 'PROFILE_NOT_FOUND'; END IF;
  IF p_ends_on <= p_starts_on THEN RAISE EXCEPTION 'INVALID_EXHIBITION_DATES'; END IF;

  IF actor_role = 'store' AND p_target_kind = 'project' THEN
    SELECT * INTO selected_store FROM public.store_profiles WHERE owner_id = auth.uid();
    SELECT * INTO selected_project FROM public.projects
      WHERE id = p_target_id AND status IN ('recruiting', 'matched');
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

  initial_status := CASE WHEN actor_role = 'creator' THEN 'approved' ELSE 'proposed' END;

  INSERT INTO public.collaborations (
    project_id, store_id, creator_id, status, starts_on, ends_on, terms
  ) VALUES (
    selected_project.id,
    selected_store.id,
    selected_project.creator_id,
    initial_status,
    p_starts_on,
    p_ends_on,
    jsonb_build_object(
      'initiatedBy', actor_role,
      'message', left(trim(p_message), 1000),
      'proposalCreatedAt', NOW()
    )
  )
  ON CONFLICT (project_id, store_id) DO UPDATE SET
    status = EXCLUDED.status,
    starts_on = EXCLUDED.starts_on,
    ends_on = EXCLUDED.ends_on,
    terms = public.collaborations.terms || EXCLUDED.terms,
    updated_at = NOW()
  WHERE public.collaborations.status NOT IN ('active', 'completed')
  RETURNING * INTO result;

  IF result.id IS NULL THEN
    SELECT * INTO result FROM public.collaborations
      WHERE project_id = selected_project.id AND store_id = selected_store.id;
    RETURN result;
  END IF;

  IF result.status IN ('proposed', 'approved') AND trim(p_message) <> '' THEN
    INSERT INTO public.collaboration_messages (collaboration_id, sender_id, content)
    VALUES (result.id, auth.uid(), left(trim(p_message), 2000));
  END IF;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.create_curit_proposal(UUID, TEXT, TEXT, DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_curit_proposal(UUID, TEXT, TEXT, DATE, DATE) TO authenticated;
