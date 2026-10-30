DROP POLICY IF EXISTS creator_posts_owner_insert ON public.creator_posts;
CREATE POLICY creator_posts_owner_insert ON public.creator_posts FOR INSERT TO authenticated
WITH CHECK (
  creator_id = (SELECT auth.uid())
  AND EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = (SELECT auth.uid()) AND p.role = 'creator'
  )
);
