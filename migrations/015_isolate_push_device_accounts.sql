-- An installation can receive notifications for one signed-in account at a time.
-- Retire ambiguous registrations from older clients until the device checks in.
UPDATE public.push_devices AS device
SET active = FALSE, updated_at = now()
WHERE device.active AND device.expo_push_token IN (
  SELECT expo_push_token
  FROM public.push_devices
  WHERE active
  GROUP BY expo_push_token
  HAVING count(*) > 1
);

CREATE UNIQUE INDEX push_devices_active_token_idx
  ON public.push_devices (expo_push_token)
  WHERE active;

CREATE FUNCTION public.register_curit_push_device(
  p_user_id uuid,
  p_expo_push_token text,
  p_platform text,
  p_device_name text
)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_expo_push_token, 0));

  UPDATE public.push_devices
  SET active = FALSE, updated_at = now()
  WHERE expo_push_token = p_expo_push_token AND user_id <> p_user_id AND active;

  INSERT INTO public.push_devices (user_id, expo_push_token, platform, device_name)
  VALUES (p_user_id, p_expo_push_token, p_platform, p_device_name)
  ON CONFLICT (user_id, expo_push_token) DO UPDATE
  SET platform = excluded.platform,
      device_name = excluded.device_name,
      active = TRUE,
      last_seen_at = now(),
      updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION public.register_curit_push_device(uuid, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_curit_push_device(uuid, text, text, text)
  TO service_role;
