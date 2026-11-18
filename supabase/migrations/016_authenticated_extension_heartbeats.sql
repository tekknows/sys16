create or replace function public.record_authenticated_extension_heartbeat(
  p_employee_id uuid,
  p_laptop_id uuid,
  p_registration_id text,
  p_extension_version text
)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Employee authentication is required.';
  end if;

  return public.record_extension_heartbeat(
    auth.uid(),
    p_employee_id,
    p_laptop_id,
    p_registration_id,
    p_extension_version
  );
end;
$$;

revoke all on function public.record_authenticated_extension_heartbeat(uuid, uuid, text, text)
  from public, anon;
grant execute on function public.record_authenticated_extension_heartbeat(uuid, uuid, text, text)
  to authenticated;

notify pgrst, 'reload schema';
