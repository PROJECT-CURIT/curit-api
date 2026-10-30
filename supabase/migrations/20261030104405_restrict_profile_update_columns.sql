-- A signed-in user may edit only public profile fields. Role and verification
-- remain server-controlled even when a client calls PostgREST directly.
REVOKE UPDATE ON TABLE public.profiles FROM authenticated;
GRANT UPDATE (display_name, handle, avatar_path) ON TABLE public.profiles TO authenticated;
