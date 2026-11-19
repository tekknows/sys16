-- Employee work schedules and authenticated attendance sessions.

alter table public.employees
  add column if not exists work_status text;

update public.employees
set work_status = 'Off Duty'
where work_status is null;

alter table public.employees
  alter column work_status set not null,
  alter column work_status set default 'Off Duty';

alter table public.employees
  drop constraint if exists employees_work_status_check;
alter table public.employees
  add constraint employees_work_status_check
  check (work_status in ('Off Duty', 'Working', 'Lunch Break'));

alter table public.laptops
  add column if not exists connectivity_status text not null default 'Offline'
    check (connectivity_status in ('Offline', 'Online')),
  add column if not exists work_session_id uuid;

create table if not exists public.employee_schedules (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  start_date date not null,
  end_date date not null,
  working_days text[] not null,
  start_time time not null,
  end_time time not null,
  lunch_enabled boolean not null default false,
  lunch_start time,
  lunch_end time,
  timezone text not null default 'Asia/Manila',
  is_active boolean not null default true,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date >= start_date),
  check (start_time < end_time),
  check (
    not lunch_enabled
    or (
      lunch_start is not null
      and lunch_end is not null
      and start_time < lunch_start
      and lunch_start < lunch_end
      and lunch_end < end_time
    )
  ),
  check (timezone = 'Asia/Manila'),
  check (
    working_days is not null
    and cardinality(working_days) between 1 and 7
    and not exists (
      select 1
      from unnest(working_days) day_name
      where day_name is null or day_name <> all (array['Mon','Tue','Wed','Thu','Fri','Sat','Sun'])
    )
  )
);

alter table public.employee_schedules
  add column if not exists lunch_enabled boolean not null default false,
  add column if not exists lunch_start time,
  add column if not exists lunch_end time;

alter table public.employee_schedules
  drop constraint if exists employee_schedules_lunch_check;
alter table public.employee_schedules
  add constraint employee_schedules_lunch_check
  check (
    not lunch_enabled
    or (
      lunch_start is not null
      and lunch_end is not null
      and start_time < lunch_start
      and lunch_start < lunch_end
      and lunch_end < end_time
    )
  );

create index if not exists idx_employee_schedules_employee_active
  on public.employee_schedules (employee_id, is_active, start_date, end_date);

create table if not exists public.attendance_sessions (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  laptop_id uuid not null references public.laptops(id) on delete restrict,
  schedule_id uuid not null references public.employee_schedules(id) on delete restrict,
  clock_in_at timestamptz not null default now(),
  scheduled_end_at timestamptz not null,
  clock_out_at timestamptz,
  status text not null default 'Working'
    check (status in ('Working', 'Clocked-out', 'Auto-ended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists uq_attendance_one_active_session
  on public.attendance_sessions (employee_id)
  where clock_out_at is null and status = 'Working';
create index if not exists idx_attendance_employee_clock
  on public.attendance_sessions (employee_id, clock_in_at desc);
create index if not exists idx_attendance_scheduled_end
  on public.attendance_sessions (scheduled_end_at)
  where clock_out_at is null;

drop trigger if exists set_employee_schedules_updated_at on public.employee_schedules;
create trigger set_employee_schedules_updated_at
before update on public.employee_schedules
for each row execute function public.set_updated_at();

drop trigger if exists set_attendance_sessions_updated_at on public.attendance_sessions;
create trigger set_attendance_sessions_updated_at
before update on public.attendance_sessions
for each row execute function public.set_updated_at();

alter table public.employee_schedules enable row level security;
alter table public.attendance_sessions enable row level security;

drop policy if exists "employee_schedules_read_authenticated" on public.employee_schedules;
create policy "employee_schedules_read_authenticated" on public.employee_schedules
  for select to authenticated
  using (
    public.is_support_staff()
    or exists (
      select 1 from public.employees
      where employees.id = employee_schedules.employee_id
        and employees.profile_id = auth.uid()
    )
  );

drop policy if exists "employee_schedules_manage_support" on public.employee_schedules;
create policy "employee_schedules_manage_support" on public.employee_schedules
  for all to authenticated
  using (public.is_support_staff())
  with check (public.is_support_staff());

drop policy if exists "attendance_sessions_read_own_or_support" on public.attendance_sessions;
create policy "attendance_sessions_read_own_or_support" on public.attendance_sessions
  for select to authenticated
  using (
    public.is_support_staff()
    or exists (
      select 1 from public.employees
      where employees.id = attendance_sessions.employee_id
        and employees.profile_id = auth.uid()
    )
  );

drop policy if exists "attendance_sessions_manage_rpc_only" on public.attendance_sessions;

grant select on public.employee_schedules to authenticated;
grant select on public.attendance_sessions to authenticated;
grant insert, update, delete on public.employee_schedules to authenticated;
revoke insert, update, delete on public.attendance_sessions
  from anon, authenticated;

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
  v_in_lunch boolean := false;
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
  where employee_id = v_employee.id and clock_out_at is null
  order by clock_in_at desc
  limit 1;

  if found then
    select * into v_schedule
    from public.employee_schedules
    where id = v_session.schedule_id;
  else
    select * into v_schedule
    from public.employee_schedules
    where employee_id = v_employee.id
      and is_active
      and start_date <= timezone('Asia/Manila', now())::date
      and end_date >= timezone('Asia/Manila', now())::date
      and timezone('Asia/Manila', now())::time >= start_time
      and timezone('Asia/Manila', now())::time <= end_time
      and trim(to_char(timezone('Asia/Manila', now()), 'Dy')) = any(working_days)
    order by start_time desc
    limit 1;
  end if;

  v_in_lunch := v_schedule.id is not null
    and v_schedule.lunch_enabled
    and timezone('Asia/Manila', now())::time >= v_schedule.lunch_start
    and timezone('Asia/Manila', now())::time < v_schedule.lunch_end;

  return jsonb_build_object(
    'employee_id', v_employee.id,
    'work_status', v_employee.work_status,
    'in_lunch', v_in_lunch,
    'active_session', case when v_session.id is null then null else jsonb_build_object(
      'id', v_session.id,
      'clock_in_at', v_session.clock_in_at,
      'scheduled_end_at', v_session.scheduled_end_at,
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

create or replace function public.clock_in_employee()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := now();
  v_local timestamp := timezone('Asia/Manila', v_now);
  v_local_date date := v_local::date;
  v_local_time time := v_local::time;
  v_employee public.employees%rowtype;
  v_schedule public.employee_schedules%rowtype;
  v_laptop public.laptops%rowtype;
  v_session public.attendance_sessions%rowtype;
  v_end timestamptz;
begin
  if auth.uid() is null then raise exception 'Employee authentication is required.'; end if;

  select * into v_employee
  from public.employees
  where profile_id = auth.uid() and active
  limit 1;
  if not found then raise exception 'The authenticated account is not an active employee.'; end if;

  if exists (
    select 1 from public.attendance_sessions
    where employee_id = v_employee.id
      and clock_out_at is null
      and status = 'Working'
  ) then
    raise exception 'You already have an active work session.';
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
  if not found then raise exception 'Clock In requires an assigned active laptop.'; end if;

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
    v_employee.id, v_laptop.id, v_schedule.id, v_now,
    v_end, 'Working'
  ) returning * into v_session;

  update public.employees
  set work_status = 'Working', updated_at = v_now
  where id = v_employee.id;

  update public.laptops
  set connectivity_status = 'Online',
      work_session_id = v_session.id,
      last_seen_at = v_now,
      updated_at = v_now
  where id = v_laptop.id;

  update public.device_connection_logs
  set connection_ended_at = coalesce(connection_ended_at, v_now),
      connection_status = 'OFFLINE'
  where laptop_id = v_laptop.id and connection_ended_at is null;

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
    'status', v_session.status
  );
end;
$$;

revoke all on function public.clock_in_employee() from public, anon;
grant execute on function public.clock_in_employee() to authenticated;

create or replace function public.clock_out_employee()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := now();
  v_employee public.employees%rowtype;
  v_session public.attendance_sessions%rowtype;
begin
  if auth.uid() is null then raise exception 'Employee authentication is required.'; end if;

  select * into v_employee
  from public.employees
  where profile_id = auth.uid() and active
  limit 1;
  if not found then raise exception 'The authenticated account is not an active employee.'; end if;

  select * into v_session
  from public.attendance_sessions
  where employee_id = v_employee.id
    and clock_out_at is null
    and status = 'Working'
  order by clock_in_at desc
  limit 1
  for update;
  if not found then raise exception 'No active work session was found.'; end if;

  update public.attendance_sessions
  set clock_out_at = v_now,
      status = 'Clocked-out',
      updated_at = v_now
  where id = v_session.id;

  update public.employees
  set work_status = 'Off Duty', updated_at = v_now
  where id = v_employee.id;

  update public.laptops
  set connectivity_status = 'Offline',
      work_session_id = null,
      updated_at = v_now
  where id = v_session.laptop_id;

  update public.device_connection_logs
  set connection_ended_at = v_now,
      connection_status = 'OFFLINE'
  where laptop_id = v_session.laptop_id and connection_ended_at is null;

  return jsonb_build_object(
    'session_id', v_session.id,
    'clock_out_at', v_now,
    'status', 'Clocked-out'
  );
end;
$$;

revoke all on function public.clock_out_employee() from public, anon;
grant execute on function public.clock_out_employee() to authenticated;

create or replace function public.auto_end_expired_work_sessions()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := now();
  v_closed integer;
  v_batch integer;
begin
  update public.attendance_sessions session
  set clock_out_at = session.scheduled_end_at,
      status = 'Auto-ended',
      updated_at = v_now
  from public.employee_schedules schedule
  where session.schedule_id = schedule.id
    and session.clock_out_at is null
    and session.status = 'Working'
    and session.scheduled_end_at <= v_now;

  get diagnostics v_closed = row_count;

  update public.attendance_sessions session
  set clock_out_at = v_now,
      status = 'Auto-ended',
      updated_at = v_now
  from public.employee_schedules schedule
  where session.schedule_id = schedule.id
    and session.clock_out_at is null
    and session.status = 'Working'
    and (
      not schedule.is_active
      or schedule.end_date < timezone('Asia/Manila', v_now)::date
    );

  get diagnostics v_batch = row_count;
  v_closed := v_closed + v_batch;

  update public.employees employee
  set work_status = 'Lunch Break', updated_at = v_now
  from public.attendance_sessions session
  join public.employee_schedules schedule on schedule.id = session.schedule_id
  where employee.id = session.employee_id
    and session.clock_out_at is null
    and session.status = 'Working'
    and schedule.is_active
    and schedule.lunch_enabled
    and timezone('Asia/Manila', v_now)::time >= schedule.lunch_start
    and timezone('Asia/Manila', v_now)::time < schedule.lunch_end;

  update public.laptops laptop
  set connectivity_status = 'Offline',
      updated_at = v_now
  from public.attendance_sessions session
  join public.employee_schedules schedule on schedule.id = session.schedule_id
  where laptop.id = session.laptop_id
    and session.clock_out_at is null
    and session.status = 'Working'
    and schedule.is_active
    and schedule.lunch_enabled
    and timezone('Asia/Manila', v_now)::time >= schedule.lunch_start
    and timezone('Asia/Manila', v_now)::time < schedule.lunch_end;

  update public.device_connection_logs log
  set connection_ended_at = v_now,
      connection_status = 'OFFLINE'
  where log.connection_ended_at is null
    and exists (
      select 1
      from public.attendance_sessions session
      join public.employee_schedules schedule on schedule.id = session.schedule_id
      where session.laptop_id = log.laptop_id
        and session.clock_out_at is null
        and session.status = 'Working'
        and schedule.is_active
        and schedule.lunch_enabled
        and timezone('Asia/Manila', v_now)::time >= schedule.lunch_start
        and timezone('Asia/Manila', v_now)::time < schedule.lunch_end
    );

  update public.employees employee
  set work_status = 'Working', updated_at = v_now
  from public.attendance_sessions session
  join public.employee_schedules schedule on schedule.id = session.schedule_id
  where employee.id = session.employee_id
    and session.clock_out_at is null
    and session.status = 'Working'
    and schedule.is_active
    and (
      not schedule.lunch_enabled
      or timezone('Asia/Manila', v_now)::time < schedule.lunch_start
      or timezone('Asia/Manila', v_now)::time >= schedule.lunch_end
    );

  update public.laptops laptop
  set connectivity_status = 'Online',
      work_session_id = session.id,
      updated_at = v_now
  from public.attendance_sessions session
  join public.employee_schedules schedule on schedule.id = session.schedule_id
  where laptop.id = session.laptop_id
    and session.clock_out_at is null
    and session.status = 'Working'
    and schedule.is_active
    and (
      not schedule.lunch_enabled
      or timezone('Asia/Manila', v_now)::time < schedule.lunch_start
      or timezone('Asia/Manila', v_now)::time >= schedule.lunch_end
    );

  update public.employees employee
  set work_status = 'Off Duty', updated_at = v_now
  where employee.work_status in ('Working', 'Lunch Break')
    and not exists (
      select 1 from public.attendance_sessions session
      where session.employee_id = employee.id
        and session.clock_out_at is null
        and session.status = 'Working'
    );

  update public.laptops laptop
  set connectivity_status = 'Offline',
      work_session_id = null,
      updated_at = v_now
  where laptop.work_session_id is not null
    and not exists (
      select 1 from public.attendance_sessions session
      where session.id = laptop.work_session_id
        and session.clock_out_at is null
        and session.status = 'Working'
    );

  update public.device_connection_logs log
  set connection_ended_at = v_now,
      connection_status = 'OFFLINE'
  where log.connection_ended_at is null
    and exists (
      select 1 from public.attendance_sessions session
      where session.laptop_id = log.laptop_id
        and session.status = 'Auto-ended'
        and session.clock_out_at <= v_now
    );

  return v_closed;
end;
$$;

revoke all on function public.auto_end_expired_work_sessions() from public, anon;
grant execute on function public.auto_end_expired_work_sessions() to authenticated;

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
  heartbeat_time timestamptz := clock_timestamp();
  active_session public.attendance_sessions%rowtype;
  registration public.device_registrations%rowtype;
  active_schedule public.employee_schedules%rowtype;
  in_lunch boolean := false;
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

  select session.* into active_session
  from public.attendance_sessions session
  where session.employee_id = p_employee_id
    and session.laptop_id = p_laptop_id
    and session.clock_out_at is null
    and session.status = 'Working'
  order by session.clock_in_at desc
  limit 1;

  if active_session.id is not null then
    select * into active_schedule
    from public.employee_schedules
    where id = active_session.schedule_id;
    in_lunch := active_schedule.lunch_enabled
      and timezone('Asia/Manila', heartbeat_time)::time >= active_schedule.lunch_start
      and timezone('Asia/Manila', heartbeat_time)::time < active_schedule.lunch_end;
  end if;

  select * into registration
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
  set last_heartbeat_at = heartbeat_time,
      extension_version = p_extension_version,
      updated_at = heartbeat_time
  where id = registration.id;

  if active_session.id is null then
    update public.laptops
    set connectivity_status = 'Offline',
        work_session_id = null,
        last_seen_at = heartbeat_time,
        extension_version = p_extension_version,
        updated_at = heartbeat_time
    where id = p_laptop_id;

    update public.device_connection_logs
    set connection_ended_at = heartbeat_time,
        connection_status = 'OFFLINE'
    where laptop_id = p_laptop_id
      and connection_ended_at is null;
    return heartbeat_time;
  end if;

  if in_lunch then
    update public.laptops
    set connectivity_status = 'Offline',
        work_session_id = active_session.id,
        last_seen_at = heartbeat_time,
        extension_version = p_extension_version,
        updated_at = heartbeat_time
    where id = p_laptop_id;

    update public.employees
    set work_status = 'Lunch Break', updated_at = heartbeat_time
    where id = p_employee_id;

    update public.device_connection_logs
    set connection_ended_at = heartbeat_time,
        connection_status = 'OFFLINE'
    where laptop_id = p_laptop_id
      and employee_id = p_employee_id
      and connection_ended_at is null;
    return heartbeat_time;
  end if;

  update public.laptops
  set connectivity_status = 'Online',
      work_session_id = active_session.id,
      last_seen_at = heartbeat_time,
      extension_version = p_extension_version,
      updated_at = heartbeat_time
  where id = p_laptop_id;

  update public.device_connection_logs
  set last_heartbeat_at = heartbeat_time,
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
      heartbeat_time, heartbeat_time, 'ONLINE'
    );
  end if;

  return heartbeat_time;
end;
$$;

revoke all on function public.record_extension_heartbeat(uuid, uuid, uuid, text, text)
  from public, anon;
grant execute on function public.record_extension_heartbeat(uuid, uuid, uuid, text, text)
  to authenticated, service_role;

create or replace function public.close_stale_device_connections()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  closed_count integer;
begin
  perform public.auto_end_expired_work_sessions();

  update public.device_connection_logs log
  set connection_ended_at = log.last_heartbeat_at + interval '2 minutes',
      connection_status = 'OFFLINE'
  where log.connection_ended_at is null
    and log.last_heartbeat_at < now() - interval '2 minutes';

  get diagnostics closed_count = row_count;

  update public.laptops laptop
  set connectivity_status = 'Offline',
      updated_at = now()
  where laptop.connectivity_status = 'Online'
    and not exists (
      select 1
      from public.device_connection_logs log
      where log.laptop_id = laptop.id
        and log.connection_ended_at is null
        and log.last_heartbeat_at >= now() - interval '2 minutes'
    );

  return closed_count;
end;
$$;

revoke all on function public.close_stale_device_connections() from public, anon;
grant execute on function public.close_stale_device_connections() to authenticated;

create extension if not exists pg_cron;

do $$
begin
  if not exists (
    select 1 from cron.job
    where jobname = 'loctiv-auto-end-work-sessions'
  ) then
    perform cron.schedule(
      'loctiv-auto-end-work-sessions',
      '* * * * *',
      'select public.auto_end_expired_work_sessions();'
    );
  end if;
end;
$$;

notify pgrst, 'reload schema';
