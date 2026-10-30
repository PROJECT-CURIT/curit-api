-- Users may mark their own notification as read, but cannot forge push state.
REVOKE UPDATE ON TABLE public.notifications FROM authenticated;
GRANT UPDATE (read_at) ON TABLE public.notifications TO authenticated;

-- Provider payloads and delivery diagnostics stay service-role only.
REVOKE ALL ON TABLE public.payment_cancellations, public.toss_webhook_events,
  public.push_delivery_logs FROM anon, authenticated;

-- Settlement payout metadata is readable only through the existing RLS policies.
REVOKE ALL ON TABLE public.payout_sellers, public.payout_requests FROM anon, authenticated;
GRANT SELECT ON TABLE public.payout_sellers, public.payout_requests TO authenticated;
