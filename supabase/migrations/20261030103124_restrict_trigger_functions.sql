-- Trigger functions must not be directly callable through the Data API.
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO supabase_auth_admin;

REVOKE ALL ON FUNCTION public.notify_curit_collaboration_change() FROM PUBLIC, anon, authenticated;
