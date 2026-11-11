alter table public.laptop_assignments
  add column if not exists expires_at timestamptz;

insert into public.system_settings (setting_key, setting_value)
values
  ('company_name', '{"value":"LOCTIV"}'::jsonb),
  ('notification_preferences', '{"value":"Email + In-app"}'::jsonb),
  ('ticket_default_status', '{"value":"Open"}'::jsonb),
  ('ticket_id_prefix', '{"value":"TKT"}'::jsonb),
  ('support_instructions', '{"value":""}'::jsonb),
  ('message_retention_days', '30'::jsonb),
  ('message_auto_cleanup', 'true'::jsonb),
  ('resolved_ticket_cleanup_days', '3'::jsonb),
  ('retention_history_days', '90'::jsonb),
  ('keep_messages_indefinitely', 'false'::jsonb),
  ('policy_sync_enabled', 'true'::jsonb),
  ('disposal_laptop_cleanup_days', '30'::jsonb),
  ('assignment_retention_days', '30'::jsonb)
on conflict (setting_key) do nothing;
update public.system_settings
set setting_value = '{"value":"LOCTIV"}'::jsonb
where setting_key = 'company_name' and setting_value = '{"value":"MINDLOCK"}'::jsonb;

create index if not exists idx_laptop_assignments_expires_at
  on public.laptop_assignments (expires_at)
  where status = 'Active' and expires_at is not null;

create or replace function public.close_expired_laptop_assignments()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  closed_count integer;
begin
  if not public.is_support_staff() then
    raise exception 'Support staff access is required.';
  end if;
  update public.laptop_assignments
  set status = 'Terminated',
      ended_at = coalesce(ended_at, now()),
      reason = coalesce(reason, 'Assignment retention period expired')
  where status = 'Active'
    and expires_at is not null
    and expires_at <= now();
  get diagnostics closed_count = row_count;
  return closed_count;
end;
$$;

revoke all on function public.close_expired_laptop_assignments() from public, anon;
grant execute on function public.close_expired_laptop_assignments() to authenticated;

create or replace function public.assign_laptop_to_employee(
  p_laptop_id uuid,
  p_employee_id uuid,
  p_assigned_by uuid,
  p_retention_days integer default 30
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_support_staff() then
    raise exception 'Support staff access is required.';
  end if;
  if p_assigned_by is distinct from auth.uid() then
    raise exception 'Assignment actor does not match the signed-in user.';
  end if;
  if p_retention_days < 1 or p_retention_days > 3650 then
    raise exception 'Assignment retention must be between 1 and 3650 days.';
  end if;
  if not exists (select 1 from public.employees where id = p_employee_id and active) then
    raise exception 'Choose an active employee.';
  end if;
  if not exists (select 1 from public.laptops where id = p_laptop_id and active and status <> 'Retired') then
    raise exception 'Choose an active laptop that is not retired.';
  end if;

  update public.laptop_assignments
  set status = 'Terminated',
      ended_at = now(),
      reason = 'Reassigned by administrator'
  where status = 'Active'
    and (laptop_id = p_laptop_id or employee_id = p_employee_id);

  insert into public.laptop_assignments (employee_id, laptop_id, assigned_by, status, expires_at)
  values (p_employee_id, p_laptop_id, p_assigned_by, 'Active', now() + make_interval(days => p_retention_days));
end;
$$;

revoke all on function public.assign_laptop_to_employee(uuid, uuid, uuid) from public, anon;
revoke all on function public.assign_laptop_to_employee(uuid, uuid, uuid, integer) from public, anon;
grant execute on function public.assign_laptop_to_employee(uuid, uuid, uuid, integer) to authenticated;

drop policy if exists "system_settings_manage_support" on public.system_settings;
create policy "system_settings_manage_support" on public.system_settings
  for all to authenticated
  using (public.is_support_staff())
  with check (public.is_support_staff());

drop policy if exists "system_settings_read_support" on public.system_settings;
create policy "system_settings_read_support" on public.system_settings
  for select to authenticated
  using (public.is_support_staff());
