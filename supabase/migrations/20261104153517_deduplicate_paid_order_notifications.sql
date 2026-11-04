ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS dedupe_key text;

CREATE UNIQUE INDEX IF NOT EXISTS notifications_user_dedupe_key_idx
  ON public.notifications (user_id, dedupe_key);
