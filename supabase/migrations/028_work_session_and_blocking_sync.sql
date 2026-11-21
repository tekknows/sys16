-- Align duplicate detection and employee monitoring with server-authoritative schedules.

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
      join public.blocking_schedules blocking_schedule
        on blocking_schedule.id = rule.schedule_id
      where rule.id is distinct from p_existing_rule_id
        and rule.is_active
        and blocking_schedule.is_active
        and (blocking_schedule.expires_on is null or blocking_schedule.expires_on >= v_today)
        and regexp_replace(
          regexp_replace(
            regexp_replace(lower(btrim(rule.domain)), '^https?://', ''),
            '^www[.]', ''
          ),
          '[/#?].*$', ''
        ) = v_domain
        and (
          (
            blocking_schedule.employee_schedule_id is not null
            and exists (
              select 1
              from public.employee_schedules employee_schedule
              where employee_schedule.id = blocking_schedule.employee_schedule_id
                and employee_schedule.employee_id = p_employee_id
                and employee_schedule.is_active
                and employee_schedule.end_date >= v_today
            )
            and (
              rule.target_profile_id = v_profile_id
              or exists (
                select 1
                from public.blocking_schedule_assignments assignment
                where assignment.schedule_id = blocking_schedule.id
                  and assignment.employee_id = p_employee_id
              )
            )
          )
          or (
            blocking_schedule.employee_schedule_id is null
            and exists (
              select 1
              from public.blocking_schedule_assignments assignment
              where assignment.schedule_id = blocking_schedule.id
                and assignment.employee_id = p_employee_id
            )
          )
          or (
            blocking_schedule.employee_schedule_id is null
            and rule.target_profile_id is null
            and lower(blocking_schedule.scope) in ('global', 'all')
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

  perform public.auto_end_expired_work_sessions();

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
    v_employee.id, v_laptop.id, v_schedule.id, v_now, v_end, 'Working'
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
    'lunch_enabled', v_schedule.lunch_enabled,
    'lunch_start', v_schedule.lunch_start,
    'lunch_end', v_schedule.lunch_end,
    'status', v_session.status
  );
end;
$$;

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

  perform public.auto_end_expired_work_sessions();

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
  if not found then
    select * into v_session
    from public.attendance_sessions
    where employee_id = v_employee.id
      and status = 'Auto-ended'
      and scheduled_end_at <= v_now
      and clock_out_at >= v_now - interval '24 hours'
    order by clock_out_at desc
    limit 1;
    if found then
      return jsonb_build_object(
        'session_id', v_session.id,
        'clock_out_at', v_session.clock_out_at,
        'status', 'Auto-ended'
      );
    end if;
    raise exception 'No active work session was found.';
  end if;

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

revoke all on function public.get_my_work_status() from public, anon;
grant execute on function public.get_my_work_status() to authenticated;
revoke all on function public.clock_in_employee() from public, anon;
grant execute on function public.clock_in_employee() to authenticated;
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
  set work_session_id = session.id,
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
    and session.scheduled_end_at > heartbeat_time
  order by session.clock_in_at desc
  limit 1
  for update;

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

drop policy if exists "usage_logs_insert_employee" on public.website_usage_logs;
create policy "usage_logs_insert_employee" on public.website_usage_logs
  for insert to authenticated
  with check (
    profile_id = auth.uid()
    and exists (
      select 1
      from public.employees employee
      join public.attendance_sessions session
        on session.employee_id = employee.id
      join public.employee_schedules schedule
        on schedule.id = session.schedule_id
      where employee.id = website_usage_logs.employee_id
        and employee.profile_id = auth.uid()
        and employee.active
        and session.status = 'Working'
        and session.clock_out_at is null
        and session.scheduled_end_at > now()
        and schedule.is_active
        and schedule.end_date >= timezone('Asia/Manila', now())::date
        and (
          not schedule.lunch_enabled
          or timezone(coalesce(schedule.timezone, 'Asia/Manila'), now())::time < schedule.lunch_start
          or timezone(coalesce(schedule.timezone, 'Asia/Manila'), now())::time >= schedule.lunch_end
        )
    )
  );

notify pgrst, 'reload schema';
