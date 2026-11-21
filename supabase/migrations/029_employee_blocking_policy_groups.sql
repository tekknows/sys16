-- Keep bulk-assignment labels on employee blocking schedules and support safe policy deletion.

alter table public.blocking_schedules
  add column if not exists assignment_group_id uuid,
  add column if not exists assignment_group_name text;

create index if not exists idx_blocking_schedules_assignment_group
  on public.blocking_schedules (assignment_group_id)
  where assignment_group_id is not null;

with policy_groups as (
  select
    blocking_schedule.employee_schedule_id,
    blocking_schedule.created_by,
    blocking_schedule.created_at,
    array_agg(distinct normalized.domain order by normalized.domain) as domains,
    array_agg(distinct blocking_schedule.id) as schedule_ids
  from public.blocking_schedules blocking_schedule
  join public.website_blocking_rules rule
    on rule.schedule_id = blocking_schedule.id
  join public.blocking_schedule_assignments assignment
    on assignment.schedule_id = blocking_schedule.id
  cross join lateral (
    select regexp_replace(lower(btrim(rule.domain)), '^www[.]', '') as domain
  ) normalized
  where blocking_schedule.assignment_group_id is null
    and blocking_schedule.employee_schedule_id is not null
    and rule.target_profile_id is not null
  group by blocking_schedule.employee_schedule_id, blocking_schedule.created_by, blocking_schedule.created_at
),
template_domains as (
  select
    template.id,
    template.name,
    array_agg(distinct normalized.domain order by normalized.domain) as domains
  from public.default_blocking_templates template
  join public.default_blocking_websites website
    on website.template_id = template.id
   and website.is_active
  cross join lateral (
    select regexp_replace(lower(btrim(website.domain)), '^www[.]', '') as domain
  ) normalized
  group by template.id, template.name
),
matches as (
  select distinct on (policy_group.employee_schedule_id, policy_group.created_by, policy_group.created_at)
    policy_group.schedule_ids,
    template.name,
    gen_random_uuid() as group_id
  from policy_groups policy_group
  join template_domains template
    on template.domains = policy_group.domains
  order by policy_group.employee_schedule_id, policy_group.created_by, policy_group.created_at, lower(template.name)
)
update public.blocking_schedules schedule
set assignment_group_id = matched.group_id,
    assignment_group_name = matched.name
from matches matched
where schedule.id = any(matched.schedule_ids);

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
  v_template_names text;
  v_active_count integer;
  v_requested_count integer;
  v_assigned_count integer;
  v_employee_schedule_id uuid;
  v_profile_id uuid;
  v_group_id uuid := gen_random_uuid();
  v_group_name text;
  v_created_at timestamptz := transaction_timestamp();
begin
  if auth.uid() is null or not public.is_support_staff() then
    raise exception 'Support staff access is required.';
  end if;
  if p_template_ids is null or cardinality(p_template_ids) = 0 or cardinality(p_template_ids) > 100 then
    raise exception 'Select between 1 and 100 website templates.';
  end if;

  select count(distinct selected.id)
    into v_requested_count
  from unnest(p_template_ids) as selected(id);

  select count(*), string_agg(template.name, ', ' order by lower(template.name))
    into v_active_count, v_template_names
  from public.default_blocking_templates template
  where template.id = any(p_template_ids)
    and template.is_active;

  if v_active_count <> v_requested_count then
    raise exception 'One or more selected website templates are inactive or no longer available.';
  end if;

  select array_agg(website.domain order by website.domain)
    into v_domains
  from public.default_blocking_websites website
  where website.template_id = any(p_template_ids)
    and website.is_active;

  if v_domains is null or cardinality(v_domains) = 0 then
    raise exception 'The selected website template has no active websites.';
  end if;

  select employee.profile_id, employee_schedule.id
    into v_profile_id, v_employee_schedule_id
  from public.employees employee
  join public.employee_schedules employee_schedule
    on employee_schedule.employee_id = employee.id
  where employee.id = p_employee_id
    and employee.active
    and employee_schedule.is_active
    and employee_schedule.end_date >= timezone('Asia/Manila', now())::date
  order by
    case when employee_schedule.start_date <= timezone('Asia/Manila', now())::date then 0 else 1 end,
    case when employee_schedule.start_date <= timezone('Asia/Manila', now())::date then employee_schedule.start_date end desc,
    case when employee_schedule.start_date > timezone('Asia/Manila', now())::date then employee_schedule.start_date end asc,
    employee_schedule.created_at desc
  limit 1;
  if v_employee_schedule_id is null then
    raise exception 'No active employee schedule found. Please assign an employee schedule first.';
  end if;

  v_group_name := v_template_names;
  v_assigned_count := public._assign_employee_blocking_domains(p_employee_id, v_domains, null);

  update public.blocking_schedules blocking_schedule
  set assignment_group_id = v_group_id,
      assignment_group_name = v_group_name,
      updated_at = now()
  from public.website_blocking_rules rule
  join public.blocking_schedule_assignments assignment
    on assignment.schedule_id = rule.schedule_id
   and assignment.employee_id = p_employee_id
  where blocking_schedule.id = rule.schedule_id
    and blocking_schedule.employee_schedule_id = v_employee_schedule_id
    and blocking_schedule.created_by = auth.uid()
    and blocking_schedule.created_at = v_created_at
    and rule.created_by = auth.uid()
    and rule.target_profile_id = v_profile_id
    and regexp_replace(lower(btrim(rule.domain)), '^www[.]', '') =
      any(array(
        select regexp_replace(lower(btrim(domain)), '^www[.]', '')
        from unnest(v_domains) as selected(domain)
      ));

  return v_assigned_count;
end;
$$;

create or replace function public.delete_website_blocking_policy(p_rule_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_schedule_id uuid;
begin
  if auth.uid() is null or not public.is_support_staff() then
    raise exception 'Support staff access is required.';
  end if;
  if p_rule_id is null then
    raise exception 'Select a website policy to delete.';
  end if;

  select rule.schedule_id
    into v_schedule_id
  from public.website_blocking_rules rule
  where rule.id = p_rule_id
  for update;
  if not found then
    raise exception 'The selected website policy could not be found.';
  end if;

  delete from public.website_blocking_rules
  where id = p_rule_id;

  if v_schedule_id is not null and not exists (
    select 1
    from public.website_blocking_rules rule
    where rule.schedule_id = v_schedule_id
  ) then
    delete from public.blocking_schedules
    where id = v_schedule_id;
  end if;
end;
$$;

revoke all on function public.assign_default_blocking_websites(uuid, uuid[]) from public, anon;
grant execute on function public.assign_default_blocking_websites(uuid, uuid[]) to authenticated;
revoke all on function public.delete_website_blocking_policy(uuid) from public, anon;
grant execute on function public.delete_website_blocking_policy(uuid) to authenticated;

notify pgrst, 'reload schema';
