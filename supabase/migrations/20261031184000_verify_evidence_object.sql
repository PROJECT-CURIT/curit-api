create or replace function public.submit_verification_request(
  p_kind text,
  p_evidence_path text,
  p_note text default ''
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_request_id uuid;
begin
  if v_user_id is null then
    raise exception 'authentication required';
  end if;

  if p_kind not in ('creator_activity', 'store_operation') then
    raise exception 'invalid verification kind';
  end if;

  if coalesce(trim(p_evidence_path), '') = ''
    or (storage.foldername(p_evidence_path))[1] is distinct from v_user_id::text
    or not exists (
      select 1 from storage.objects
      where bucket_id = 'verification-evidence' and name = p_evidence_path and owner = v_user_id
    ) then
    raise exception 'invalid evidence path';
  end if;

  select role into v_role from public.profiles where id = v_user_id;
  if (p_kind = 'creator_activity' and v_role <> 'creator')
    or (p_kind = 'store_operation' and v_role <> 'store') then
    raise exception 'verification kind does not match user role';
  end if;

  insert into public.verification_requests (
    user_id, kind, status, evidence_path, note, review_note, submitted_at, reviewed_at, updated_at
  ) values (
    v_user_id, p_kind, 'pending', p_evidence_path, left(coalesce(p_note, ''), 1000), '', now(), null, now()
  )
  on conflict (user_id, kind) do update set
    status = 'pending',
    evidence_path = excluded.evidence_path,
    note = excluded.note,
    review_note = '',
    submitted_at = now(),
    reviewed_at = null,
    updated_at = now()
  returning id into v_request_id;

  return v_request_id;
end;
$$;

revoke all on function public.submit_verification_request(text, text, text) from public;
grant execute on function public.submit_verification_request(text, text, text) to authenticated;
