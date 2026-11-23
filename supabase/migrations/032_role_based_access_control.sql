-- Align dashboard and extension permissions with the Administrator, IT Staff,
-- and Employee role model.

create or replace function public._rbac_has_active_employee(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when auth.role() is distinct from 'service_role'
      and auth.uid() is distinct from p_profile_id
      then false
    else exists (
    select 1
    from public.user_roles role
    join public.employees employee on employee.profile_id = role.profile_id
    where role.profile_id = p_profile_id
      and role.role_name = 'Employee'
      and role.revoked_at is null
      and employee.active
      and not exists (
        select 1
        from public.user_roles staff_role
        where staff_role.profile_id = role.profile_id
          and staff_role.role_name in ('Administrator', 'IT Staff')
          and staff_role.revoked_at is null
      )
    )
  end;
$$;
revoke all on function public._rbac_has_active_employee(uuid) from public, anon;
grant execute on function public._rbac_has_active_employee(uuid) to authenticated, service_role;

drop policy if exists "profiles_update_own" on public.profiles;
drop policy if exists "profiles_manage_support" on public.profiles;
create policy "profiles_manage_admin" on public.profiles
  for update to authenticated
  using (public.is_administrator())
  with check (public.is_administrator());

drop policy if exists "employees_manage_support" on public.employees;
create policy "employees_manage_admin" on public.employees
  for all to authenticated
  using (public.is_administrator())
  with check (public.is_administrator());
drop policy if exists "employees_select_self" on public.employees;
drop policy if exists "employees_select_staff" on public.employees;
create policy "employees_select_staff" on public.employees
  for select to authenticated
  using (
    public.is_support_staff()
    or (profile_id = auth.uid() and public._rbac_has_active_employee(auth.uid()))
  );

drop policy if exists "laptops_manage_support" on public.laptops;
create policy "laptops_manage_admin" on public.laptops
  for all to authenticated
  using (public.is_administrator())
  with check (public.is_administrator());
drop policy if exists "laptops_view_staff_or_assigned" on public.laptops;
drop policy if exists "laptops_view_auth_users" on public.laptops;
create policy "laptops_view_staff_or_assigned" on public.laptops
  for select to authenticated
  using (
    public.is_support_staff()
    or exists (
      select 1
      from public.laptop_assignments assignment
      join public.employees employee on employee.id = assignment.employee_id
      where assignment.laptop_id = laptops.id
        and assignment.status = 'Active'
        and (assignment.expires_at is null or assignment.expires_at > now())
        and laptops.active
        and laptops.status <> 'Retired'
        and employee.profile_id = auth.uid()
        and public._rbac_has_active_employee(auth.uid())
    )
  );

drop policy if exists "user_roles_assign_employee_support" on public.user_roles;
drop policy if exists "user_roles_restore_employee_support" on public.user_roles;
drop policy if exists "user_roles_select_own" on public.user_roles;
drop policy if exists "user_roles_manage_admin" on public.user_roles;
create policy "user_roles_select_own" on public.user_roles
  for select to authenticated
  using (profile_id = auth.uid() or public.is_support_staff());
create policy "user_roles_manage_admin" on public.user_roles
  for all to authenticated
  using (public.is_administrator())
  with check (public.is_administrator());

drop policy if exists "admins_manage_admin" on public.admins;
create policy "admins_manage_admin" on public.admins
  for all to authenticated
  using (public.is_administrator())
  with check (public.is_administrator());

drop policy if exists "laptop_assignments_select_participant" on public.laptop_assignments;
create policy "laptop_assignments_select_participant" on public.laptop_assignments
  for select to authenticated
  using (
    public.is_support_staff()
    or exists (
      select 1 from public.employees employee
      where employee.id = laptop_assignments.employee_id
        and employee.profile_id = auth.uid()
        and public._rbac_has_active_employee(auth.uid())
    )
  );
drop policy if exists "assignments_manage_support" on public.laptop_assignments;
create policy "assignments_manage_support" on public.laptop_assignments
  for all to authenticated
  using (public.is_support_staff())
  with check (public.is_support_staff());

drop policy if exists "change_requests_select_participant" on public.laptop_change_requests;
create policy "change_requests_select_participant" on public.laptop_change_requests
  for select to authenticated
  using (profile_id = auth.uid() or public.is_support_staff());
drop policy if exists "change_requests_insert_self" on public.laptop_change_requests;
create policy "change_requests_insert_self" on public.laptop_change_requests
  for insert to authenticated
  with check (
    profile_id = auth.uid()
    and public._rbac_has_active_employee(auth.uid())
  );
drop policy if exists "change_requests_review_support" on public.laptop_change_requests;
create policy "change_requests_review_admin" on public.laptop_change_requests
  for update to authenticated
  using (public.is_administrator())
  with check (public.is_administrator());

drop policy if exists "system_settings_manage_support" on public.system_settings;
drop policy if exists "system_settings_read_support" on public.system_settings;
create policy "system_settings_manage_admin" on public.system_settings
  for all to authenticated
  using (public.is_administrator())
  with check (public.is_administrator());

drop policy if exists "ticket_categories_manage_support" on public.ticket_categories;
create policy "ticket_categories_manage_admin" on public.ticket_categories
  for all to authenticated
  using (public.is_administrator())
  with check (public.is_administrator());

drop policy if exists "tickets_insert_owner" on public.tickets;
create policy "tickets_insert_owner" on public.tickets
  for insert to authenticated
  with check (
    profile_id = auth.uid()
    and status = 'Open'
    and priority = 'Normal'
    and assigned_to is null
    and public._rbac_has_active_employee(auth.uid())
    and exists (
      select 1
      from public.employees employee
      join public.laptop_assignments assignment
        on assignment.employee_id = employee.id
       and assignment.status = 'Active'
       and (assignment.expires_at is null or assignment.expires_at > now())
      join public.laptops laptop
        on laptop.id = assignment.laptop_id
       and laptop.active
       and laptop.status <> 'Retired'
      where employee.id = tickets.employee_id
        and employee.profile_id = auth.uid()
        and employee.active
        and (tickets.laptop_id is null or tickets.laptop_id = laptop.id)
    )
  );

drop policy if exists "blocking_schedules_read_authenticated" on public.blocking_schedules;
create policy "blocking_schedules_read_assigned" on public.blocking_schedules
  for select to authenticated
  using (
    public.is_support_staff()
    or (
      public._rbac_has_active_employee(auth.uid())
      and (
        lower(coalesce(scope, 'global')) in ('global', 'all')
        or exists (
          select 1
          from public.blocking_schedule_assignments assignment
          join public.employees employee on employee.id = assignment.employee_id
          where assignment.schedule_id = blocking_schedules.id
            and employee.profile_id = auth.uid()
        )
        or exists (
          select 1
          from public.blocking_schedule_assignments assignment
          join public.laptop_assignments laptop_assignment
            on laptop_assignment.laptop_id = assignment.laptop_id
           and laptop_assignment.status = 'Active'
           and (laptop_assignment.expires_at is null or laptop_assignment.expires_at > now())
          join public.employees employee on employee.id = laptop_assignment.employee_id
          join public.laptops laptop on laptop.id = laptop_assignment.laptop_id
           and laptop.active
           and laptop.status <> 'Retired'
          where assignment.schedule_id = blocking_schedules.id
            and employee.profile_id = auth.uid()
        )
      )
    )
  );

drop policy if exists "blocking_assignments_read_authenticated" on public.blocking_schedule_assignments;
create policy "blocking_assignments_read_assigned" on public.blocking_schedule_assignments
  for select to authenticated
  using (
    public.is_support_staff()
    or (
      public._rbac_has_active_employee(auth.uid())
      and (
        exists (
          select 1 from public.employees employee
          where employee.id = blocking_schedule_assignments.employee_id
            and employee.profile_id = auth.uid()
        )
        or exists (
          select 1
          from public.laptop_assignments laptop_assignment
          join public.employees employee on employee.id = laptop_assignment.employee_id
          where laptop_assignment.laptop_id = blocking_schedule_assignments.laptop_id
            and laptop_assignment.status = 'Active'
            and (laptop_assignment.expires_at is null or laptop_assignment.expires_at > now())
            and employee.profile_id = auth.uid()
        )
      )
    )
  );

drop policy if exists "website_rules_read_authenticated" on public.website_blocking_rules;
create policy "website_rules_read_assigned" on public.website_blocking_rules
  for select to authenticated
  using (
  public.is_support_staff()
  or (
    public._rbac_has_active_employee(auth.uid())
    and (
      target_profile_id = auth.uid()
      or (schedule_id is null and target_profile_id is null)
      or exists (
        select 1
        from public.blocking_schedules schedule
        where schedule.id = website_blocking_rules.schedule_id
          and lower(coalesce(schedule.scope, 'global')) in ('global', 'all')
      )
      or exists (
        select 1
        from public.blocking_schedule_assignments assignment
        join public.employees employee on employee.id = assignment.employee_id
        where assignment.schedule_id = website_blocking_rules.schedule_id
          and employee.profile_id = auth.uid()
      )
      or exists (
        select 1
        from public.blocking_schedule_assignments assignment
        join public.laptop_assignments laptop_assignment
          on laptop_assignment.laptop_id = assignment.laptop_id
         and laptop_assignment.status = 'Active'
         and (laptop_assignment.expires_at is null or laptop_assignment.expires_at > now())
        join public.employees employee on employee.id = laptop_assignment.employee_id
        where assignment.schedule_id = website_blocking_rules.schedule_id
          and employee.profile_id = auth.uid()
      )
    )
  )
  );

create or replace function public.has_ticket_access(target_ticket_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.is_support_staff()
  or exists (
    select 1
    from public.tickets ticket
    where ticket.id = target_ticket_id
      and ticket.profile_id = auth.uid()
      and public._rbac_has_active_employee(auth.uid())
      and exists (
        select 1
        from public.employees employee
        join public.laptop_assignments assignment
          on assignment.employee_id = employee.id
         and assignment.status = 'Active'
         and (assignment.expires_at is null or assignment.expires_at > now())
        join public.laptops laptop
          on laptop.id = assignment.laptop_id
         and laptop.active
         and laptop.status <> 'Retired'
        where employee.profile_id = auth.uid()
          and employee.active
      )
  );
$$;

drop policy if exists "tickets_select_participant" on public.tickets;
create policy "tickets_select_participant" on public.tickets
  for select to authenticated
  using (
    public.has_ticket_access(id)
  );

drop policy if exists "employee_schedules_read_authenticated" on public.employee_schedules;
create policy "employee_schedules_read_authenticated" on public.employee_schedules
  for select to authenticated
  using (
  public.is_support_staff()
  or (
    public._rbac_has_active_employee(auth.uid())
    and exists (
      select 1 from public.employees employee
      where employee.id = employee_schedules.employee_id
        and employee.profile_id = auth.uid()
    )
  )
  );

drop policy if exists "attendance_sessions_read_own_or_support" on public.attendance_sessions;
create policy "attendance_sessions_read_own_or_support" on public.attendance_sessions
  for select to authenticated
  using (
  public.is_support_staff()
  or (
    public._rbac_has_active_employee(auth.uid())
    and exists (
      select 1 from public.employees employee
      where employee.id = attendance_sessions.employee_id
        and employee.profile_id = auth.uid()
    )
  )
  );

drop policy if exists "usage_logs_select_authorized" on public.website_usage_logs;
create policy "usage_logs_select_authorized" on public.website_usage_logs
  for select to authenticated
  using (
    public.is_support_staff()
    or (profile_id = auth.uid() and public._rbac_has_active_employee(auth.uid()))
  );

-- Employee-only work session RPCs are wrapped so privileged implementations
-- retain their existing schedule, assignment, and attendance logic.
alter function public.clock_in_employee() rename to _rbac_clock_in_employee_impl;
alter function public.clock_out_employee() rename to _rbac_clock_out_employee_impl;
alter function public.get_my_work_status() rename to _rbac_get_my_work_status_impl;
alter function public.record_extension_heartbeat(uuid, uuid, uuid, text, text)
  rename to _rbac_record_extension_heartbeat_impl;

create or replace function public.clock_in_employee()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public._rbac_has_active_employee(auth.uid()) then
    raise exception 'An active Employee account is required.';
  end if;
  return public._rbac_clock_in_employee_impl();
end;
$$;

create or replace function public.clock_out_employee()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public._rbac_has_active_employee(auth.uid()) then
    raise exception 'An active Employee account is required.';
  end if;
  return public._rbac_clock_out_employee_impl();
end;
$$;

create or replace function public.get_my_work_status()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public._rbac_has_active_employee(auth.uid()) then
    raise exception 'An active Employee account is required.';
  end if;
  return public._rbac_get_my_work_status_impl();
end;
$$;

create or replace function public.record_extension_heartbeat(
  p_profile_id uuid,
  p_employee_id uuid,
  p_laptop_id uuid,
  p_registration_id text,
  p_extension_version text
)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.role() is distinct from 'service_role'
     and auth.uid() is distinct from p_profile_id then
    raise exception 'The authenticated profile does not match the heartbeat profile.';
  end if;
  if not public._rbac_has_active_employee(p_profile_id) then
    raise exception 'An active Employee account is required.';
  end if;
  return public._rbac_record_extension_heartbeat_impl(
    p_profile_id,
    p_employee_id,
    p_laptop_id,
    p_registration_id,
    p_extension_version
  );
end;
$$;

revoke all on function public._rbac_clock_in_employee_impl() from public, anon, authenticated, service_role;
revoke all on function public._rbac_clock_out_employee_impl() from public, anon, authenticated, service_role;
revoke all on function public._rbac_get_my_work_status_impl() from public, anon, authenticated, service_role;
revoke all on function public._rbac_record_extension_heartbeat_impl(uuid, uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.clock_in_employee() from public, anon;
revoke all on function public.clock_out_employee() from public, anon;
revoke all on function public.get_my_work_status() from public, anon;
revoke all on function public.record_extension_heartbeat(uuid, uuid, uuid, text, text)
  from public, anon;
grant execute on function public.clock_in_employee() to authenticated;
grant execute on function public.clock_out_employee() to authenticated;
grant execute on function public.get_my_work_status() to authenticated;
grant execute on function public.record_extension_heartbeat(uuid, uuid, uuid, text, text)
  to authenticated, service_role;
revoke all on function public.auto_end_expired_work_sessions() from public, anon, authenticated;
grant execute on function public.auto_end_expired_work_sessions() to service_role;

drop policy if exists "usage_logs_insert_employee" on public.website_usage_logs;
create policy "usage_logs_insert_employee" on public.website_usage_logs
  for insert to authenticated
  with check (
    profile_id = auth.uid()
    and client_event_id is not null
    and browser_mode in ('Normal', 'Incognito')
    and public._rbac_has_active_employee(auth.uid())
    and exists (
      select 1
      from public.employees employee
      join public.attendance_sessions session
        on session.employee_id = employee.id
       and session.id = website_usage_logs.attendance_session_id
      join public.laptop_assignments assignment
        on assignment.employee_id = employee.id
       and assignment.laptop_id = session.laptop_id
      join public.employee_schedules schedule
        on schedule.id = session.schedule_id
      where employee.id = website_usage_logs.employee_id
        and employee.profile_id = auth.uid()
        and employee.active
        and session.clock_out_at is null
        and session.status in ('Working', 'Overtime', 'Extended Session')
        and assignment.status = 'Active'
        and (assignment.expires_at is null or assignment.expires_at > now())
        and (
          not schedule.lunch_enabled
          or timezone(coalesce(schedule.timezone, 'Asia/Manila'), now())::time < schedule.lunch_start
          or timezone(coalesce(schedule.timezone, 'Asia/Manila'), now())::time >= schedule.lunch_end
        )
    )
  );

create or replace function public.delete_laptop_record(p_laptop_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_laptop public.laptops%rowtype;
begin
  if auth.uid() is null or not public.is_administrator() then
    raise exception 'Administrator access is required.';
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
