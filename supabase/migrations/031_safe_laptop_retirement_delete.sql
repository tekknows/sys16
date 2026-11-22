-- Safely retire laptop records requested through Laptop Management.
-- Historical attendance, tickets, analytics, and connection records remain intact.

create or replace function public.delete_laptop_record(p_laptop_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_laptop public.laptops%rowtype;
begin
  if auth.uid() is null or not public.is_support_staff() then
    raise exception 'Support staff access is required.';
  end if;
  if p_laptop_id is null then
    raise exception 'Select a laptop to delete.';
  end if;

  select * into v_laptop
  from public.laptops
  where id = p_laptop_id
  for update;
  if not found then
    raise exception 'Laptop record was not found.';
  end if;

  if exists (
    select 1
    from public.attendance_sessions session
    where session.laptop_id = p_laptop_id
      and session.clock_out_at is null
  ) then
    raise exception 'This laptop has an active work session. Clock out or terminate the session before deleting the laptop.';
  end if;

  update public.laptop_assignments
  set status = 'Terminated',
      ended_at = coalesce(ended_at, now()),
      reason = coalesce(reason, 'Laptop record deleted'),
      updated_at = now()
  where laptop_id = p_laptop_id
    and status = 'Active';

  update public.device_registrations
  set is_active = false,
      revoked_at = coalesce(revoked_at, now()),
      updated_at = now()
  where laptop_id = p_laptop_id
    and is_active;

  update public.device_connection_logs
  set connection_ended_at = coalesce(connection_ended_at, now()),
      connection_status = 'OFFLINE'
  where laptop_id = p_laptop_id
    and connection_ended_at is null;

  update public.laptops
  set status = 'Retired',
      active = false,
      connectivity_status = 'Offline',
      device_registration_id = null,
      work_session_id = null,
      updated_at = now()
  where id = p_laptop_id;

  delete from public.blocking_schedule_assignments
  where laptop_id = p_laptop_id;

  return jsonb_build_object(
    'laptop_id', p_laptop_id,
    'laptop_code', v_laptop.laptop_id,
    'status', 'Retired'
  );
end;
$$;

revoke all on function public.delete_laptop_record(uuid) from public, anon;
grant execute on function public.delete_laptop_record(uuid) to authenticated;

notify pgrst, 'reload schema';
