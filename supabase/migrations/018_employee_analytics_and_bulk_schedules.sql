update public.website_usage_logs usage
set employee_id = employee.id
from public.employees employee
where usage.employee_id is null
  and usage.profile_id = employee.profile_id;

create index if not exists idx_usage_logs_employee_recorded
  on public.website_usage_logs (employee_id, recorded_at);

drop policy if exists "usage_logs_insert_employee" on public.website_usage_logs;
create policy "usage_logs_insert_employee" on public.website_usage_logs
  for insert to authenticated
  with check (
    profile_id = auth.uid()
    and exists (
      select 1
      from public.employees employee
      where employee.id = website_usage_logs.employee_id
        and employee.profile_id = auth.uid()
        and employee.active
    )
  );
grant insert on public.website_usage_logs to authenticated;

create or replace function public.create_bulk_blocking_schedules(
  p_domains text[],
  p_target_profile_id uuid,
  p_start_time time,
  p_end_time time,
  p_lunch_start time,
  p_lunch_end time,
  p_days text[]
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  normalized_domain text;
  v_schedule_id uuid;
  target_employee_id uuid;
  created_domains integer := 0;
  allowed_days text[] := array['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
begin
  if auth.uid() is null or not public.is_support_staff() then
    raise exception 'Support staff access is required.';
  end if;

  if p_domains is null
     or cardinality(p_domains) = 0
     or cardinality(p_domains) > 100 then
    raise exception 'Provide between 1 and 100 website domains.';
  end if;

  if p_start_time is null or p_end_time is null or p_lunch_start is null or p_lunch_end is null
     or not (p_start_time < p_lunch_start and p_lunch_start < p_lunch_end and p_lunch_end < p_end_time) then
    raise exception 'Work and lunch times must be in order and within the same day.';
  end if;

  if p_days is null or cardinality(p_days) = 0
     or exists (
       select 1
       from unnest(p_days) selected_day
       where selected_day is null or not (selected_day = any(allowed_days))
     ) then
    raise exception 'Select at least one valid day of the week.';
  end if;

  if p_target_profile_id is not null then
    select employee.id
      into target_employee_id
    from public.employees employee
    where employee.profile_id = p_target_profile_id
      and employee.active;
    if target_employee_id is null then
      raise exception 'The selected employee is not active.';
    end if;
  end if;

  for normalized_domain in
    select distinct regexp_replace(lower(btrim(input_domain)), '^www[.]', '')
    from unnest(p_domains) input_domain
    order by 1
  loop
    if normalized_domain is null
       or normalized_domain = ''
       or length(normalized_domain) > 253
       or normalized_domain !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?([.][a-z]{2,})+$' then
      raise exception 'Invalid website domain: %', normalized_domain;
    end if;

    insert into public.blocking_schedules (
      name, scope, start_time, end_time, days_of_week, is_active, created_by, timezone, description
    ) values (
      normalized_domain,
      case when p_target_profile_id is null then 'Global' else 'Employee' end,
      p_start_time,
      p_lunch_start,
      p_days,
      true,
      auth.uid(),
      'Asia/Manila',
      'Bulk work-hours block before lunch'
    )
    returning id into v_schedule_id;

    insert into public.website_blocking_rules (domain, is_active, created_by, schedule_id, target_profile_id)
    values (normalized_domain, true, auth.uid(), v_schedule_id, p_target_profile_id);

    if target_employee_id is not null then
      insert into public.blocking_schedule_assignments (schedule_id, employee_id, assigned_by)
      values (v_schedule_id, target_employee_id, auth.uid());
    end if;

    insert into public.blocking_schedules (
      name, scope, start_time, end_time, days_of_week, is_active, created_by, timezone, description
    ) values (
      normalized_domain,
      case when p_target_profile_id is null then 'Global' else 'Employee' end,
      p_lunch_end,
      p_end_time,
      p_days,
      true,
      auth.uid(),
      'Asia/Manila',
      'Bulk work-hours block after lunch'
    )
    returning id into v_schedule_id;

    insert into public.website_blocking_rules (domain, is_active, created_by, schedule_id, target_profile_id)
    values (normalized_domain, true, auth.uid(), v_schedule_id, p_target_profile_id);

    if target_employee_id is not null then
      insert into public.blocking_schedule_assignments (schedule_id, employee_id, assigned_by)
      values (v_schedule_id, target_employee_id, auth.uid());
    end if;

    created_domains := created_domains + 1;
  end loop;

  return created_domains;
end;
$$;

revoke all on function public.create_bulk_blocking_schedules(text[], uuid, time, time, time, time, text[])
  from public, anon;
grant execute on function public.create_bulk_blocking_schedules(text[], uuid, time, time, time, time, text[])
  to authenticated;

notify pgrst, 'reload schema';
