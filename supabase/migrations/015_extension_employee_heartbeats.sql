alter table public.laptops
  add column if not exists last_seen_at timestamptz,
  add column if not exists extension_version text;

alter table public.device_registrations
  add column if not exists last_heartbeat_at timestamptz,
  add column if not exists extension_version text;

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
set search_path = public
as $$
declare
  heartbeat_time timestamptz := clock_timestamp();
  registration public.device_registrations%rowtype;
  active_connection public.device_connection_logs%rowtype;
begin
  if p_registration_id !~ '^DEV-[0-9A-F-]{36}$'
     or p_extension_version !~ '^[0-9]+\.[0-9]+\.[0-9]+'
     or length(p_extension_version) > 32 then
    raise exception 'Heartbeat device details are invalid.';
  end if;

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
      and (assignment.expires_at is null or assignment.expires_at > heartbeat_time)
      and laptop.active
      and laptop.status <> 'Retired'
  ) then
    raise exception 'Laptop is not actively assigned to this employee.';
  end if;

  select * into registration
  from public.device_registrations
  where registration_id = p_registration_id
    and laptop_id = p_laptop_id
    and profile_id = p_profile_id
    and is_active
  for update;
  if not found then
    raise exception 'Device registration is invalid or revoked.';
  end if;

  update public.device_registrations
  set last_heartbeat_at = heartbeat_time,
      extension_version = p_extension_version,
      updated_at = heartbeat_time
  where id = registration.id;

  update public.laptops
  set last_seen_at = heartbeat_time,
      extension_version = p_extension_version,
      updated_at = heartbeat_time
  where id = p_laptop_id;

  select * into active_connection
  from public.device_connection_logs
  where laptop_id = p_laptop_id
    and device_registration_id = p_registration_id
    and connection_ended_at is null
  order by connection_started_at desc
  limit 1
  for update;

  if not found
     or active_connection.employee_id is distinct from p_employee_id
     or active_connection.last_heartbeat_at < heartbeat_time - interval '2 minutes' then
    if found then
      update public.device_connection_logs
      set connection_ended_at = last_heartbeat_at,
          connection_status = 'OFFLINE'
      where id = active_connection.id;
    end if;

    insert into public.device_connection_logs (
      laptop_id,
      employee_id,
      device_registration_id,
      connection_started_at,
      last_heartbeat_at,
      connection_status
    ) values (
      p_laptop_id,
      p_employee_id,
      p_registration_id,
      heartbeat_time,
      heartbeat_time,
      'ONLINE'
    );
  else
    update public.device_connection_logs
    set last_heartbeat_at = heartbeat_time,
        connection_status = 'ONLINE'
    where id = active_connection.id;
  end if;

  return heartbeat_time;
end;
$$;

revoke all on function public.record_extension_heartbeat(uuid, uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.record_extension_heartbeat(uuid, uuid, uuid, text, text)
  to service_role;

create or replace function public.close_stale_device_connections()
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

  update public.device_connection_logs
  set connection_ended_at = last_heartbeat_at + interval '2 minutes',
      connection_status = 'OFFLINE'
  where connection_ended_at is null
    and last_heartbeat_at < now() - interval '2 minutes';

  get diagnostics closed_count = row_count;
  return closed_count;
end;
$$;

revoke all on function public.close_stale_device_connections() from public, anon;
grant execute on function public.close_stale_device_connections() to authenticated;

create or replace function public.register_laptop_device(
  p_laptop_id uuid,
  p_registration_id text,
  p_credential_hash text,
  p_mac_address text,
  p_registered_by uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  assigned_profile_id uuid;
  current_mac_address text;
begin
  if p_registration_id !~ '^DEV-[0-9A-F-]{36}$'
     or p_credential_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid device registration details.';
  end if;
  if p_mac_address is not null and p_mac_address !~* '^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$' then
    raise exception 'Enter a valid MAC address.';
  end if;

  select mac_address into current_mac_address
  from public.laptops
  where id = p_laptop_id and active and status <> 'Retired'
  for update;
  if not found then
    raise exception 'Laptop was not found or is retired.';
  end if;

  select employee.profile_id into assigned_profile_id
  from public.laptop_assignments assignment
  join public.employees employee on employee.id = assignment.employee_id
  where assignment.laptop_id = p_laptop_id
    and assignment.status = 'Active'
    and (assignment.expires_at is null or assignment.expires_at > now())
    and employee.active
  order by assignment.assigned_at desc
  limit 1;
  if assigned_profile_id is null then
    raise exception 'Assign an active employee to this laptop before registering the device.';
  end if;

  if coalesce(p_mac_address, current_mac_address) is not null and exists (
    select 1 from public.laptops
    where lower(mac_address) = lower(coalesce(p_mac_address, current_mac_address))
      and id <> p_laptop_id
  ) then
    raise exception 'This MAC address is already registered to another laptop.';
  end if;

  update public.device_registrations
  set is_active = false,
      revoked_at = coalesce(revoked_at, now()),
      revoked_by = p_registered_by
  where laptop_id = p_laptop_id and is_active;

  update public.device_connection_logs
  set connection_ended_at = coalesce(connection_ended_at, now()),
      connection_status = 'OFFLINE'
  where laptop_id = p_laptop_id and connection_ended_at is null;

  insert into public.device_registrations (
    profile_id, laptop_id, registration_id, credential_hash, mac_address, registered_by, is_active
  ) values (
    assigned_profile_id, p_laptop_id, p_registration_id, p_credential_hash,
    coalesce(p_mac_address, current_mac_address), p_registered_by, true
  );

  update public.laptops
  set device_registration_id = p_registration_id,
      mac_address = coalesce(p_mac_address, mac_address),
      last_seen_at = null,
      extension_version = null
  where id = p_laptop_id;
end;
$$;

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
declare
  employee_profile_id uuid;
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

  select profile_id into employee_profile_id
  from public.employees
  where id = p_employee_id and active;
  if not found then
    raise exception 'Choose an active employee.';
  end if;
  if not exists (
    select 1 from public.laptops
    where id = p_laptop_id and active and status <> 'Retired'
  ) then
    raise exception 'Choose an active laptop that is not retired.';
  end if;

  update public.device_connection_logs
  set connection_ended_at = coalesce(connection_ended_at, now()),
      connection_status = 'OFFLINE'
  where connection_ended_at is null
    and laptop_id in (
      select laptop_id
      from public.laptop_assignments
      where status = 'Active'
        and (laptop_id = p_laptop_id or employee_id = p_employee_id)
    );

  update public.laptop_assignments
  set status = 'Terminated',
      ended_at = now(),
      reason = 'Reassigned by administrator'
  where status = 'Active'
    and (laptop_id = p_laptop_id or employee_id = p_employee_id);

  insert into public.laptop_assignments (employee_id, laptop_id, assigned_by, status, expires_at)
  values (
    p_employee_id, p_laptop_id, p_assigned_by, 'Active',
    now() + make_interval(days => p_retention_days)
  );

  update public.device_registrations
  set profile_id = employee_profile_id,
      last_heartbeat_at = null,
      updated_at = now()
  where laptop_id = p_laptop_id and is_active;

  update public.laptops
  set last_seen_at = null,
      extension_version = null
  where id = p_laptop_id;
end;
$$;

revoke all on function public.register_laptop_device(uuid, text, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.register_laptop_device(uuid, text, text, text, uuid)
  to service_role;
revoke all on function public.assign_laptop_to_employee(uuid, uuid, uuid, integer)
  from public, anon;
grant execute on function public.assign_laptop_to_employee(uuid, uuid, uuid, integer)
  to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'laptops'
    ) then
      execute 'alter publication supabase_realtime add table public.laptops';
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'device_registrations'
    ) then
      execute 'alter publication supabase_realtime add table public.device_registrations';
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'device_connection_logs'
    ) then
      execute 'alter publication supabase_realtime add table public.device_connection_logs';
    end if;
  end if;
end;
$$;
