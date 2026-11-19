-- Reuse employee schedules as the source of truth for employee-scoped blocking policies.

create table if not exists public.default_blocking_websites (
  id uuid primary key default gen_random_uuid(),
  domain text not null,
  is_active boolean not null default true,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint default_blocking_websites_domain_check
    check (
      domain = lower(btrim(domain))
      and domain !~ '^www[.]'
      and length(domain) <= 253
      and domain ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?([.][a-z]{2,})+$'
    )
);

create unique index if not exists idx_default_blocking_websites_normalized_domain
  on public.default_blocking_websites (regexp_replace(lower(btrim(domain)), '^www[.]', ''));

alter table public.default_blocking_websites enable row level security;
drop policy if exists "default_blocking_websites_read_support" on public.default_blocking_websites;
create policy "default_blocking_websites_read_support" on public.default_blocking_websites
  for select to authenticated using (public.is_support_staff());
drop policy if exists "default_blocking_websites_manage_support" on public.default_blocking_websites;
create policy "default_blocking_websites_manage_support" on public.default_blocking_websites
  for all to authenticated
  using (public.is_support_staff())
  with check (public.is_support_staff());
grant select, insert, update, delete on public.default_blocking_websites to authenticated;

alter table public.blocking_schedules
  add column if not exists employee_schedule_id uuid
    references public.employee_schedules(id) on delete cascade;

create index if not exists idx_blocking_schedules_employee_schedule
  on public.blocking_schedules (employee_schedule_id);

revoke all on function public.create_bulk_blocking_schedules(text[], uuid, time, time, time, time, text[])
  from public, anon, authenticated;

create or replace function public._assign_employee_blocking_domains(
  p_employee_id uuid,
  p_domains text[],
  p_existing_rule_id uuid default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile_id uuid;
  v_employee_schedule public.employee_schedules%rowtype;
  v_domain text;
  v_schedule_id uuid;
  v_existing_schedule_id uuid;
  v_count integer := 0;
  v_today date := timezone('Asia/Manila', now())::date;
begin
  if auth.uid() is null or not public.is_support_staff() then
    raise exception 'Support staff access is required.';
  end if;

  if p_domains is null or cardinality(p_domains) = 0 or cardinality(p_domains) > 100 then
    raise exception 'Select between 1 and 100 website domains.';
  end if;
  if p_employee_id is null then
    raise exception 'Select an employee.';
  end if;
  if p_existing_rule_id is not null and cardinality(p_domains) <> 1 then
    raise exception 'Only one website can be edited at a time.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_employee_id::text, 0));

  select employee.profile_id
    into v_profile_id
  from public.employees employee
  where employee.id = p_employee_id
    and employee.active
  for update;
  if v_profile_id is null then
    raise exception 'The selected employee is not active.';
  end if;

  select schedule.*
    into v_employee_schedule
  from public.employee_schedules schedule
  where schedule.employee_id = p_employee_id
    and schedule.is_active
    and schedule.end_date >= v_today
  order by
    case when schedule.start_date <= v_today then 0 else 1 end,
    case when schedule.start_date <= v_today then schedule.start_date end desc,
    case when schedule.start_date > v_today then schedule.start_date end asc,
    schedule.created_at desc
  limit 1
  for share;
  if v_employee_schedule.id is null then
    raise exception 'No active employee schedule found. Please assign an employee schedule first.';
  end if;

  if p_existing_rule_id is not null then
    select rule.schedule_id
      into v_existing_schedule_id
    from public.website_blocking_rules rule
    where rule.id = p_existing_rule_id
      and (
        rule.target_profile_id = v_profile_id
        or exists (
          select 1
          from public.blocking_schedule_assignments assignment
          where assignment.schedule_id = rule.schedule_id
            and assignment.employee_id = p_employee_id
        )
      )
    for update;
    if not found then
      raise exception 'The selected employee-specific website policy could not be found.';
    end if;
    if v_existing_schedule_id is not null and exists (
      select 1
      from public.blocking_schedule_assignments assignment
      where assignment.schedule_id = v_existing_schedule_id
        and (assignment.employee_id is distinct from p_employee_id or assignment.laptop_id is not null)
    ) then
      raise exception 'A shared website policy cannot be converted to an employee-specific policy.';
    end if;
    if v_existing_schedule_id is not null and (
      exists (
        select 1
        from public.blocking_schedules schedule
        where schedule.id = v_existing_schedule_id
          and lower(schedule.scope) not in ('employee', 'employee-specific')
      )
      or exists (
        select 1
        from public.website_blocking_rules rule
        where rule.schedule_id = v_existing_schedule_id
          and rule.id <> p_existing_rule_id
      )
    ) then
      raise exception 'A shared website policy cannot be edited as an individual employee policy.';
    end if;
  end if;

  for v_domain in
    select distinct regexp_replace(
      regexp_replace(
        regexp_replace(lower(btrim(selected.input_domain)), '^https?://', ''),
        '^www[.]', ''
      ),
      '[/#?].*$', ''
    )
    from unnest(p_domains) as selected(input_domain)
    order by 1
  loop
    if v_domain is null
       or v_domain = ''
       or length(v_domain) > 253
       or v_domain !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?([.][a-z]{2,})+$' then
      raise exception 'Invalid website domain: %', v_domain;
    end if;

    if exists (
      select 1
      from public.website_blocking_rules rule
      where rule.id is distinct from p_existing_rule_id
        and regexp_replace(
          regexp_replace(
            regexp_replace(lower(btrim(rule.domain)), '^https?://', ''),
            '^www[.]', ''
          ),
          '[/#?].*$', ''
        ) = v_domain
        and (
          rule.target_profile_id = v_profile_id
          or exists (
            select 1
            from public.blocking_schedule_assignments assignment
            where assignment.schedule_id = rule.schedule_id
              and assignment.employee_id = p_employee_id
          )
          or (
            rule.target_profile_id is null
            and rule.is_active
            and (
              rule.schedule_id is null
              or exists (
                select 1
                from public.blocking_schedules global_schedule
                where global_schedule.id = rule.schedule_id
                  and lower(global_schedule.scope) in ('global', 'all')
                  and global_schedule.is_active
              )
            )
          )
        )
    ) then
      raise exception 'A website blocking policy for % is already assigned to this employee.', v_domain;
    end if;

    if p_existing_rule_id is not null then
      if v_existing_schedule_id is null then
        insert into public.blocking_schedules (
          name, scope, start_time, end_time, days_of_week, starts_on, expires_on,
          is_active, created_by, timezone, employee_schedule_id
        ) values (
          v_domain, 'Employee', v_employee_schedule.start_time, v_employee_schedule.end_time,
          v_employee_schedule.working_days, v_employee_schedule.start_date, v_employee_schedule.end_date,
          true, auth.uid(), v_employee_schedule.timezone, v_employee_schedule.id
        )
        returning id into v_schedule_id;
      else
        v_schedule_id := v_existing_schedule_id;
        update public.blocking_schedules
        set name = v_domain,
            scope = 'Employee',
            start_time = v_employee_schedule.start_time,
            end_time = v_employee_schedule.end_time,
            days_of_week = v_employee_schedule.working_days,
            starts_on = v_employee_schedule.start_date,
            expires_on = v_employee_schedule.end_date,
            timezone = v_employee_schedule.timezone,
            employee_schedule_id = v_employee_schedule.id,
            updated_at = now()
        where id = v_schedule_id;
      end if;

      update public.website_blocking_rules
      set domain = v_domain,
          target_profile_id = v_profile_id,
          schedule_id = v_schedule_id,
          updated_at = now()
      where id = p_existing_rule_id;

      delete from public.blocking_schedule_assignments
      where schedule_id = v_schedule_id
        and employee_id = p_employee_id;
      insert into public.blocking_schedule_assignments (schedule_id, employee_id, assigned_by)
      values (v_schedule_id, p_employee_id, auth.uid());
    else
      insert into public.blocking_schedules (
        name, scope, start_time, end_time, days_of_week, starts_on, expires_on,
        is_active, created_by, timezone, employee_schedule_id
      ) values (
        v_domain, 'Employee', v_employee_schedule.start_time, v_employee_schedule.end_time,
        v_employee_schedule.working_days, v_employee_schedule.start_date, v_employee_schedule.end_date,
        true, auth.uid(), v_employee_schedule.timezone, v_employee_schedule.id
      )
      returning id into v_schedule_id;

      insert into public.website_blocking_rules (
        domain, is_active, created_by, schedule_id, target_profile_id
      ) values (
        v_domain, true, auth.uid(), v_schedule_id, v_profile_id
      );

      insert into public.blocking_schedule_assignments (schedule_id, employee_id, assigned_by)
      values (v_schedule_id, p_employee_id, auth.uid());
    end if;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke all on function public._assign_employee_blocking_domains(uuid, text[], uuid)
  from public, anon, authenticated;

create or replace function public.save_employee_blocking_policy(
  p_employee_id uuid,
  p_domain text,
  p_existing_rule_id uuid default null
)
returns integer
language sql
security definer
set search_path = public, pg_temp
as $$
  select public._assign_employee_blocking_domains(p_employee_id, array[p_domain], p_existing_rule_id);
$$;

create or replace function public.assign_default_blocking_websites(
  p_employee_id uuid,
  p_template_ids uuid[]
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_domains text[];
  v_active_count integer;
  v_requested_count integer;
begin
  if auth.uid() is null or not public.is_support_staff() then
    raise exception 'Support staff access is required.';
  end if;
  if p_template_ids is null or cardinality(p_template_ids) = 0 or cardinality(p_template_ids) > 100 then
    raise exception 'Select between 1 and 100 default websites.';
  end if;

  select count(distinct selected.id)
    into v_requested_count
  from unnest(p_template_ids) as selected(id);

  select array_agg(template.domain order by template.domain), count(*)
    into v_domains, v_active_count
  from public.default_blocking_websites template
  where template.id = any(p_template_ids)
    and template.is_active;

  if v_active_count <> v_requested_count then
    raise exception 'One or more selected default websites are inactive or no longer available.';
  end if;

  return public._assign_employee_blocking_domains(p_employee_id, v_domains, null);
end;
$$;

revoke all on function public.save_employee_blocking_policy(uuid, text, uuid) from public, anon;
revoke all on function public.assign_default_blocking_websites(uuid, uuid[]) from public, anon;
grant execute on function public.save_employee_blocking_policy(uuid, text, uuid) to authenticated;
grant execute on function public.assign_default_blocking_websites(uuid, uuid[]) to authenticated;

notify pgrst, 'reload schema';
