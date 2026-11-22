-- LOCTIV overtime, private-browsing analytics, and assignment validation.

alter table public.employees
  alter column work_status set default 'Clocked Out';
alter table public.employees
  drop constraint if exists employees_work_status_check;
alter table public.employees
  add constraint employees_work_status_check
  check (work_status in (
    'Off Duty', 'Working', 'Lunch Break', 'Overtime',
    'Extended Session', 'Clocked Out', 'Offline'
  ));

alter table public.attendance_sessions
  add column if not exists overtime_seconds integer not null default 0;
alter table public.attendance_sessions
  drop constraint if exists attendance_sessions_status_check;
alter table public.attendance_sessions
  add constraint attendance_sessions_status_check
  check (status in (
    'Working', 'Overtime', 'Extended Session',
    'Clocked-out', 'Clocked Out', 'Auto-ended'
  ));

drop index if exists public.uq_attendance_one_active_session;
create unique index uq_attendance_one_active_session
  on public.attendance_sessions (employee_id)
  where clock_out_at is null;

alter table public.website_usage_logs
  add column if not exists browser_mode text not null default 'Normal',
  add column if not exists client_event_id uuid,
  add column if not exists attendance_session_id uuid references public.attendance_sessions(id) on delete set null;
alter table public.website_usage_logs
  drop constraint if exists website_usage_logs_browser_mode_check;
alter table public.website_usage_logs
  add constraint website_usage_logs_browser_mode_check
  check (browser_mode in ('Normal', 'Incognito'));
create unique index if not exists uq_website_usage_client_event
  on public.website_usage_logs (client_event_id)
  where client_event_id is not null;
create index if not exists idx_website_usage_attendance_session
  on public.website_usage_logs (attendance_session_id, recorded_at);

insert into public.system_settings (setting_key, setting_value)
values ('maximum_overtime_hours', '2'::jsonb)
on conflict (setting_key) do nothing;

create or replace function public.get_maximum_overtime_hours()
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when coalesce(trim(both '"' from setting.setting_value::text), '') ~ '^[0-9]+([.][0-9]+)?$'
      and (trim(both '"' from setting.setting_value::text))::numeric between 0.25 and 24
    then (trim(both '"' from setting.setting_value::text))::numeric
    else 2
  end
  from public.system_settings setting
  where setting.setting_key = 'maximum_overtime_hours';
$$;

revoke all on function public.get_maximum_overtime_hours() from public, anon, authenticated;

create or replace function public.auto_end_expired_work_sessions()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_overtime_limit interval := make_interval(
    hours => floor(public.get_maximum_overtime_hours())::integer,
    mins => ((public.get_maximum_overtime_hours() - floor(public.get_maximum_overtime_hours())) * 60)::integer
  );
  v_changed integer := 0;
begin
  update public.attendance_sessions session
  set status = 'Overtime',
      overtime_seconds = greatest(
        0,
        floor(extract(epoch from (v_now - session.scheduled_end_at)))::integer
      ),
      updated_at = v_now
  where session.clock_out_at is null
    and session.status = 'Working'
    and session.scheduled_end_at <= v_now;
  get diagnostics v_changed = row_count;

  update public.attendance_sessions session
  set status = 'Extended Session',
      overtime_seconds = greatest(
        0,
        floor(extract(epoch from (v_now - session.scheduled_end_at)))::integer
      ),
      updated_at = v_now
  where session.clock_out_at is null
    and session.status in ('Overtime', 'Extended Session')
    and session.scheduled_end_at + v_overtime_limit <= v_now;

  update public.employees employee
  set work_status = case
    when laptop.connectivity_status <> 'Online'
      or laptop.last_seen_at is null
      or laptop.last_seen_at < v_now - interval '2 minutes'
      then 'Offline'
    when session.status = 'Extended Session' then 'Extended Session'
    when session.status = 'Overtime' then 'Overtime'
    when schedule.lunch_enabled
      and timezone(schedule.timezone, v_now)::time >= schedule.lunch_start
      and timezone(schedule.timezone, v_now)::time < schedule.lunch_end
      then 'Lunch Break'
    else 'Working'
  end,
  updated_at = v_now
  from public.attendance_sessions session
  join public.employee_schedules schedule on schedule.id = session.schedule_id
  join public.laptops laptop on laptop.id = session.laptop_id
  where employee.id = session.employee_id
    and session.clock_out_at is null
    and session.status in ('Working', 'Overtime', 'Extended Session');

  update public.employees employee
  set work_status = 'Clocked Out',
      updated_at = v_now
  where employee.work_status in ('Working', 'Lunch Break', 'Overtime', 'Extended Session', 'Offline')
    and not exists (
      select 1
      from public.attendance_sessions session
      where session.employee_id = employee.id
        and session.clock_out_at is null
    );

  return v_changed;
end;
$$;

revoke all on function public.auto_end_expired_work_sessions() from public, anon;
grant execute on function public.auto_end_expired_work_sessions() to authenticated;

create or replace function public.notify_admins_of_overtime_status()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_employee_name text;
begin
  if old.status is not distinct from new.status
     or new.status not in ('Overtime', 'Extended Session') then
    return new;
  end if;

  select coalesce(profile.full_name, employee.user_id)
    into v_employee_name
  from public.employees employee
  join public.profiles profile on profile.id = employee.profile_id
  where employee.id = new.employee_id;

  insert into public.notifications (user_id, title, body, link)
  select role.profile_id,
    case new.status
      when 'Overtime' then 'Employee overtime started'
      else 'Employee extended session threshold reached'
    end,
    case new.status
      when 'Overtime'
        then format('%s remains clocked in beyond the scheduled end time.', coalesce(v_employee_name, 'An employee'))
      else format('%s exceeded the configured overtime threshold and remains clocked in.', coalesce(v_employee_name, 'An employee'))
    end,
    'dashboard.html#employees'
  from public.user_roles role
  where role.role_name = 'Administrator'
    and role.revoked_at is null;
  return new;
end;
$$;

drop trigger if exists attendance_overtime_notifications on public.attendance_sessions;
create trigger attendance_overtime_notifications
after update of status on public.attendance_sessions
for each row
execute function public.notify_admins_of_overtime_status();

create or replace function public.clock_out_employee()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_employee public.employees%rowtype;
  v_session public.attendance_sessions%rowtype;
  v_overtime_seconds integer;
begin
  if auth.uid() is null then
    raise exception 'Employee authentication is required.';
  end if;

  select * into v_employee
  from public.employees
  where profile_id = auth.uid() and active
  limit 1;
  if not found then
    raise exception 'The authenticated account is not an active employee.';
  end if;

  select * into v_session
  from public.attendance_sessions
  where employee_id = v_employee.id
    and clock_out_at is null
  order by clock_in_at desc
  limit 1
  for update;
  if not found then
    raise exception 'No active work session was found.';
  end if;

  v_overtime_seconds := greatest(
    0,
    floor(extract(epoch from (v_now - v_session.scheduled_end_at)))::integer
  );

  update public.attendance_sessions
  set clock_out_at = v_now,
      status = 'Clocked Out',
      overtime_seconds = v_overtime_seconds,
      updated_at = v_now
  where id = v_session.id;

  update public.employees
  set work_status = 'Clocked Out',
      updated_at = v_now
  where id = v_employee.id;

  update public.laptops
  set work_session_id = null,
      updated_at = v_now
  where id = v_session.laptop_id;

  return jsonb_build_object(
    'session_id', v_session.id,
    'clock_out_at', v_now,
    'overtime_seconds', v_overtime_seconds,
    'status', 'Clocked Out'
  );
end;
$$;

revoke all on function public.clock_out_employee() from public, anon;
grant execute on function public.clock_out_employee() to authenticated;

create or replace function public.clock_in_employee()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_local timestamp := timezone('Asia/Manila', v_now);
  v_local_date date := v_local::date;
  v_local_time time := v_local::time;
  v_employee public.employees%rowtype;
  v_schedule public.employee_schedules%rowtype;
  v_laptop public.laptops%rowtype;
  v_session public.attendance_sessions%rowtype;
  v_end timestamptz;
begin
  if auth.uid() is null then
    raise exception 'Employee authentication is required.';
  end if;

  perform public.auto_end_expired_work_sessions();

  select * into v_employee
  from public.employees
  where profile_id = auth.uid() and active
  limit 1
  for update;
  if not found then
    raise exception 'The authenticated account is not an active employee.';
  end if;

  if exists (
    select 1
    from public.attendance_sessions
    where employee_id = v_employee.id
      and clock_out_at is null
  ) then
    raise exception 'You already have an active work session.';
  end if;

  select laptop.* into v_laptop
  from public.laptop_assignments assignment
  join public.laptops laptop on laptop.id = assignment.laptop_id
  where assignment.employee_id = v_employee.id
    and assignment.status = 'Active'
    and (assignment.expires_at is null or assignment.expires_at > v_now)
    and laptop.active
    and laptop.status <> 'Retired'
  order by assignment.assigned_at desc
  limit 1;
  if not found then
    raise exception 'Clock In requires an assigned active laptop.';
  end if;

  select * into v_schedule
  from public.employee_schedules
  where employee_id = v_employee.id
    and is_active
    and start_date <= v_local_date
    and end_date >= v_local_date
    and v_local_time >= start_time
    and v_local_time < end_time
    and trim(to_char(v_local, 'Dy')) = any(working_days)
  order by start_time desc
  limit 1;
  if not found then
    raise exception 'Clock In is not allowed: no active schedule authorizes this time.';
  end if;

  if v_schedule.lunch_enabled
     and v_local_time >= v_schedule.lunch_start
     and v_local_time < v_schedule.lunch_end then
    raise exception 'Clock In is not allowed during the scheduled lunch break.';
  end if;

  v_end := make_timestamptz(
    extract(year from v_local)::integer,
    extract(month from v_local)::integer,
    extract(day from v_local)::integer,
    extract(hour from v_schedule.end_time)::integer,
    extract(minute from v_schedule.end_time)::integer,
    extract(second from v_schedule.end_time)::double precision,
    'Asia/Manila'
  );

  insert into public.attendance_sessions (
    employee_id, laptop_id, schedule_id, clock_in_at, scheduled_end_at, status
  ) values (
    v_employee.id, v_laptop.id, v_schedule.id, v_now, v_end, 'Working'
  ) returning * into v_session;

  update public.employees
  set work_status = 'Working',
      updated_at = v_now
  where id = v_employee.id;

  update public.laptops
  set work_session_id = v_session.id,
      updated_at = v_now
  where id = v_laptop.id;

  insert into public.device_connection_logs (
    laptop_id, employee_id, device_registration_id,
    connection_started_at, last_heartbeat_at, connection_status
  )
  select v_laptop.id, v_employee.id, coalesce(v_laptop.device_registration_id, 'SESSION'),
         v_now, v_now, 'ONLINE';

  return jsonb_build_object(
    'session_id', v_session.id,
    'employee_id', v_employee.id,
    'laptop_id', v_laptop.id,
    'clock_in_at', v_session.clock_in_at,
    'scheduled_end_at', v_session.scheduled_end_at,
    'lunch_enabled', v_schedule.lunch_enabled,
    'lunch_start', v_schedule.lunch_start,
    'lunch_end', v_schedule.lunch_end,
    'status', v_session.status
  );
end;
$$;

revoke all on function public.clock_in_employee() from public, anon;
grant execute on function public.clock_in_employee() to authenticated;

create or replace function public.get_my_work_status()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_employee public.employees%rowtype;
  v_session public.attendance_sessions%rowtype;
  v_schedule public.employee_schedules%rowtype;
  v_laptop public.laptops%rowtype;
  v_now timestamptz := clock_timestamp();
  v_status text;
begin
  if auth.uid() is null then
    raise exception 'Employee authentication is required.';
  end if;

  perform public.auto_end_expired_work_sessions();

  select * into v_employee
  from public.employees
  where profile_id = auth.uid() and active
  limit 1;
  if not found then
    raise exception 'The authenticated account is not an active employee.';
  end if;

  select * into v_session
  from public.attendance_sessions
  where employee_id = v_employee.id
    and clock_out_at is null
  order by clock_in_at desc
  limit 1;

  if v_session.id is not null then
    select * into v_schedule
    from public.employee_schedules
    where id = v_session.schedule_id;
    select * into v_laptop
    from public.laptops
    where id = v_session.laptop_id;

    v_status := case
      when v_laptop.connectivity_status <> 'Online'
        or v_laptop.last_seen_at is null
        or v_laptop.last_seen_at < v_now - interval '2 minutes'
        then 'Offline'
      when v_session.status = 'Extended Session' then 'Extended Session'
      when v_session.status = 'Overtime' then 'Overtime'
      when v_schedule.lunch_enabled
        and timezone(v_schedule.timezone, v_now)::time >= v_schedule.lunch_start
        and timezone(v_schedule.timezone, v_now)::time < v_schedule.lunch_end
        then 'Lunch Break'
      else 'Working'
    end;
  else
    v_status := 'Clocked Out';
  end if;

  if v_schedule.id is null and v_employee.id is not null then
    select * into v_schedule
    from public.employee_schedules
    where employee_id = v_employee.id
      and is_active
      and start_date <= timezone('Asia/Manila', v_now)::date
      and end_date >= timezone('Asia/Manila', v_now)::date
      and timezone('Asia/Manila', v_now)::time >= start_time
      and timezone('Asia/Manila', v_now)::time < end_time
      and trim(to_char(timezone('Asia/Manila', v_now), 'Dy')) = any(working_days)
    order by start_time desc
    limit 1;
  end if;

  return jsonb_build_object(
    'employee_id', v_employee.id,
    'work_status', v_status,
    'maximum_overtime_hours', public.get_maximum_overtime_hours(),
    'in_lunch', v_status = 'Lunch Break',
    'active_session', case when v_session.id is null then null else jsonb_build_object(
      'id', v_session.id,
      'laptop_id', v_session.laptop_id,
      'clock_in_at', v_session.clock_in_at,
      'scheduled_end_at', v_session.scheduled_end_at,
      'status', v_session.status,
      'overtime_seconds', greatest(
        0,
        floor(extract(epoch from (v_now - v_session.scheduled_end_at)))::integer
      ),
      'schedule_id', v_schedule.id
    ) end,
    'schedule', case when v_schedule.id is null then null else jsonb_build_object(
      'id', v_schedule.id,
      'start_date', v_schedule.start_date,
      'end_date', v_schedule.end_date,
      'working_days', v_schedule.working_days,
      'start_time', v_schedule.start_time,
      'end_time', v_schedule.end_time,
      'lunch_enabled', v_schedule.lunch_enabled,
      'lunch_start', v_schedule.lunch_start,
      'lunch_end', v_schedule.lunch_end,
      'timezone', v_schedule.timezone
    ) end
  );
end;
$$;

revoke all on function public.get_my_work_status() from public, anon;
grant execute on function public.get_my_work_status() to authenticated;

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
declare
  v_now timestamptz := clock_timestamp();
  v_registration public.device_registrations%rowtype;
  v_session public.attendance_sessions%rowtype;
  v_schedule public.employee_schedules%rowtype;
begin
  perform public.auto_end_expired_work_sessions();

  if not exists (
    select 1
    from public.employees employee
    where employee.id = p_employee_id
      and employee.profile_id = p_profile_id
      and employee.active
  ) then
    raise exception 'Authenticated employee record is inactive or mismatched.';
  end if;

  if not exists (
    select 1
    from public.laptop_assignments assignment
    join public.laptops laptop on laptop.id = assignment.laptop_id
    where assignment.employee_id = p_employee_id
      and assignment.laptop_id = p_laptop_id
      and assignment.status = 'Active'
      and (assignment.expires_at is null or assignment.expires_at > v_now)
      and laptop.active
      and laptop.status <> 'Retired'
  ) then
    raise exception 'The employee is not actively assigned to this laptop.';
  end if;

  select * into v_registration
  from public.device_registrations
  where registration_id = p_registration_id
    and laptop_id = p_laptop_id
    and profile_id = p_profile_id
    and is_active
  limit 1;
  if not found then
    raise exception 'Device registration is invalid or revoked.';
  end if;

  update public.device_registrations
  set last_heartbeat_at = v_now,
      extension_version = p_extension_version,
      updated_at = v_now
  where id = v_registration.id;

  select * into v_session
  from public.attendance_sessions
  where employee_id = p_employee_id
    and laptop_id = p_laptop_id
    and clock_out_at is null
  order by clock_in_at desc
  limit 1;

  update public.laptops
  set connectivity_status = 'Online',
      work_session_id = v_session.id,
      last_seen_at = v_now,
      extension_version = p_extension_version,
      updated_at = v_now
  where id = p_laptop_id;

  update public.device_connection_logs
  set connection_ended_at = v_now,
      connection_status = 'OFFLINE'
  where laptop_id = p_laptop_id
    and employee_id is distinct from p_employee_id
    and connection_ended_at is null;

  update public.device_connection_logs
  set last_heartbeat_at = v_now,
      connection_status = 'ONLINE'
  where laptop_id = p_laptop_id
    and employee_id = p_employee_id
    and connection_ended_at is null;
  if not found then
    insert into public.device_connection_logs (
      laptop_id, employee_id, device_registration_id,
      connection_started_at, last_heartbeat_at, connection_status
    ) values (
      p_laptop_id, p_employee_id, p_registration_id,
      v_now, v_now, 'ONLINE'
    );
  end if;

  if v_session.id is not null then
    select * into v_schedule
    from public.employee_schedules
    where id = v_session.schedule_id;

    update public.employees
    set work_status = case
          when v_schedule.lunch_enabled
            and timezone(v_schedule.timezone, v_now)::time >= v_schedule.lunch_start
            and timezone(v_schedule.timezone, v_now)::time < v_schedule.lunch_end
            then 'Lunch Break'
          when v_session.status = 'Extended Session' then 'Extended Session'
          when v_session.status = 'Overtime' then 'Overtime'
          else 'Working'
        end,
        updated_at = v_now
    where id = p_employee_id;
  else
    update public.laptops
    set connectivity_status = 'Online',
        work_session_id = null,
        last_seen_at = v_now,
        extension_version = p_extension_version,
        updated_at = v_now
    where id = p_laptop_id;

    update public.employees
    set work_status = 'Clocked Out',
        updated_at = v_now
    where id = p_employee_id;
  end if;

  perform public.auto_end_expired_work_sessions();
  return v_now;
end;
$$;

revoke all on function public.record_extension_heartbeat(uuid, uuid, uuid, text, text)
  from public, anon;
grant execute on function public.record_extension_heartbeat(uuid, uuid, uuid, text, text)
  to authenticated, service_role;

drop policy if exists "tickets_insert_owner" on public.tickets;
create policy "tickets_insert_owner" on public.tickets
  for insert with check (
    profile_id = auth.uid()
    and status = 'Open'
    and priority = 'Normal'
    and assigned_to is null
    and exists (
      select 1
      from public.user_roles role
      where role.profile_id = auth.uid()
        and role.role_name = 'Employee'
        and role.revoked_at is null
    )
    and exists (
      select 1
      from public.employees employee
      join public.laptop_assignments assignment
        on assignment.employee_id = employee.id
      join public.laptops laptop
        on laptop.id = assignment.laptop_id
      where employee.id = tickets.employee_id
        and employee.profile_id = auth.uid()
        and employee.active
        and assignment.laptop_id = tickets.laptop_id
        and assignment.status = 'Active'
        and (assignment.expires_at is null or assignment.expires_at > now())
        and laptop.active
        and laptop.status <> 'Retired'
    )
  );

drop policy if exists "usage_logs_insert_employee" on public.website_usage_logs;
create policy "usage_logs_insert_employee" on public.website_usage_logs
  for insert to authenticated
  with check (
    profile_id = auth.uid()
    and client_event_id is not null
    and browser_mode in ('Normal', 'Incognito')
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

create or replace function public.sync_employee_schedule_to_blocking_policies()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.blocking_schedules
  set start_time = new.start_time,
      end_time = new.end_time,
      days_of_week = new.working_days,
      starts_on = new.start_date,
      expires_on = new.end_date,
      timezone = new.timezone,
      updated_at = now()
  where employee_schedule_id = new.id;
  return new;
end;
$$;

drop trigger if exists employee_schedule_sync_blocking_policies on public.employee_schedules;
create trigger employee_schedule_sync_blocking_policies
after update of start_time, end_time, working_days, start_date, end_date, timezone
on public.employee_schedules
for each row
execute function public.sync_employee_schedule_to_blocking_policies();

notify pgrst, 'reload schema';
