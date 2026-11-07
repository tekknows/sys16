alter table public.laptops
  add column if not exists mac_address text,
  add column if not exists last_seen_at timestamptz;

create unique index if not exists idx_laptops_mac_address_unique
  on public.laptops (lower(mac_address))
  where mac_address is not null and btrim(mac_address) <> '';

alter table public.device_registrations
  add column if not exists credential_hash text,
  add column if not exists mac_address text,
  add column if not exists registered_by uuid references public.profiles(id),
  add column if not exists revoked_at timestamptz,
  add column if not exists revoked_by uuid references public.profiles(id);

create index if not exists idx_device_registrations_laptop_active
  on public.device_registrations (laptop_id, is_active, last_heartbeat_at desc);

create table if not exists public.device_connection_logs (
  id uuid primary key default gen_random_uuid(),
  laptop_id uuid not null references public.laptops(id) on delete restrict,
  employee_id uuid references public.employees(id) on delete set null,
  device_registration_id text not null,
  connection_started_at timestamptz not null default now(),
  connection_ended_at timestamptz,
  last_heartbeat_at timestamptz not null default now(),
  connection_status text not null default 'ONLINE' check (connection_status in ('ONLINE', 'OFFLINE')),
  recorded_at timestamptz not null default now()
);

alter table public.device_connection_logs
  add column if not exists employee_id uuid references public.employees(id) on delete set null;

create index if not exists idx_device_connection_logs_laptop_recorded
  on public.device_connection_logs (laptop_id, recorded_at desc);
create index if not exists idx_device_connection_logs_started
  on public.device_connection_logs (connection_started_at desc);

alter table public.device_registrations enable row level security;
alter table public.device_heartbeats enable row level security;
alter table public.device_connection_logs enable row level security;
revoke all on public.device_registrations, public.device_heartbeats, public.device_connection_logs from anon, authenticated;
grant select (id, laptop_id, registration_id, mac_address, is_active, last_heartbeat_at, created_at, revoked_at)
  on public.device_registrations to authenticated;
grant select on public.device_heartbeats, public.device_connection_logs to authenticated;

drop policy if exists "device_registrations_read_support" on public.device_registrations;
create policy "device_registrations_read_support" on public.device_registrations
  for select to authenticated using (public.is_support_staff());

drop policy if exists "device_heartbeats_read_support" on public.device_heartbeats;
create policy "device_heartbeats_read_support" on public.device_heartbeats
  for select to authenticated using (public.is_support_staff());

drop policy if exists "device_connection_logs_read_support" on public.device_connection_logs;
create policy "device_connection_logs_read_support" on public.device_connection_logs
  for select to authenticated using (public.is_support_staff());

create or replace function public.assign_laptop_to_employee(
  p_laptop_id uuid,
  p_employee_id uuid,
  p_assigned_by uuid
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

  insert into public.laptop_assignments (employee_id, laptop_id, assigned_by, status)
  values (p_employee_id, p_laptop_id, p_assigned_by, 'Active');
end;
$$;

revoke all on function public.assign_laptop_to_employee(uuid, uuid, uuid) from public, anon;
grant execute on function public.assign_laptop_to_employee(uuid, uuid, uuid) to authenticated;

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
  if p_registration_id !~ '^DEV-[0-9A-F-]{36}$' or p_credential_hash !~ '^[0-9a-f]{64}$' then
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

  if coalesce(p_mac_address, current_mac_address) is not null and exists (
    select 1 from public.laptops
    where lower(mac_address) = lower(coalesce(p_mac_address, current_mac_address)) and id <> p_laptop_id
  ) then
    raise exception 'This MAC address is already registered to another laptop.';
  end if;

  select e.profile_id into assigned_profile_id
  from public.laptop_assignments a
  join public.employees e on e.id = a.employee_id
  where a.laptop_id = p_laptop_id and a.status = 'Active'
  limit 1;

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
    assigned_profile_id, p_laptop_id, p_registration_id, p_credential_hash, coalesce(p_mac_address, current_mac_address), p_registered_by, true
  );

  update public.laptops
  set device_registration_id = p_registration_id,
      mac_address = coalesce(p_mac_address, mac_address)
  where id = p_laptop_id;
end;
$$;

revoke all on function public.register_laptop_device(uuid, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.register_laptop_device(uuid, text, text, text, uuid) to service_role;

create or replace function public.revoke_laptop_device(
  p_laptop_id uuid,
  p_revoked_by uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_registration_id text;
begin
  select device_registration_id into current_registration_id
  from public.laptops
  where id = p_laptop_id
  for update;

  if not found then
    raise exception 'Laptop was not found.';
  end if;

  update public.device_registrations
  set is_active = false,
      revoked_at = coalesce(revoked_at, now()),
      revoked_by = p_revoked_by
  where laptop_id = p_laptop_id and is_active;

  update public.device_connection_logs
  set connection_ended_at = coalesce(connection_ended_at, now()),
      connection_status = 'OFFLINE'
  where laptop_id = p_laptop_id and connection_ended_at is null;

  update public.laptops
  set device_registration_id = null
  where id = p_laptop_id and device_registration_id = current_registration_id;
end;
$$;

revoke all on function public.revoke_laptop_device(uuid, uuid) from public, anon, authenticated;
grant execute on function public.revoke_laptop_device(uuid, uuid) to service_role;

create or replace function public.record_device_heartbeat(
  p_registration_id text,
  p_credential_hash text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  registration public.device_registrations%rowtype;
  current_connection public.device_connection_logs%rowtype;
  active_employee_id uuid;
  heartbeat_time timestamptz := now();
begin
  select * into registration
  from public.device_registrations
  where registration_id = p_registration_id
    and is_active
    and credential_hash = p_credential_hash;

  if not found or registration.laptop_id is null then
    raise exception 'Device registration is invalid or revoked.';
  end if;

  perform 1 from public.laptops where id = registration.laptop_id for update;
  if not found then
    raise exception 'Device registration is invalid or revoked.';
  end if;
  select * into registration
  from public.device_registrations
  where id = registration.id
    and is_active
    and credential_hash = p_credential_hash
  for update;
  if not found then
    raise exception 'Device registration is invalid or revoked.';
  end if;

  insert into public.device_heartbeats (laptop_id, device_registration_id, heartbeat_at)
  values (registration.laptop_id, registration.registration_id, heartbeat_time);

  update public.device_registrations
  set last_heartbeat_at = heartbeat_time
  where id = registration.id;

  update public.laptops
  set last_seen_at = heartbeat_time,
      last_reported_activity = heartbeat_time
  where id = registration.laptop_id;

  select employee_id into active_employee_id
  from public.laptop_assignments
  where laptop_id = registration.laptop_id and status = 'Active'
  limit 1;

  select * into current_connection
  from public.device_connection_logs
  where laptop_id = registration.laptop_id
    and device_registration_id = registration.registration_id
    and connection_ended_at is null
  order by connection_started_at desc
  limit 1
  for update;

  if not found
     or current_connection.last_heartbeat_at < heartbeat_time - interval '3 minutes'
     or current_connection.employee_id is distinct from active_employee_id then
    if found then
      update public.device_connection_logs
      set connection_ended_at = current_connection.last_heartbeat_at,
          connection_status = 'OFFLINE'
      where id = current_connection.id;
    end if;

    insert into public.device_connection_logs (
      laptop_id, employee_id, device_registration_id, connection_started_at, last_heartbeat_at, connection_status
    ) values (
      registration.laptop_id, active_employee_id, registration.registration_id, heartbeat_time, heartbeat_time, 'ONLINE'
    );
  else
    update public.device_connection_logs
    set last_heartbeat_at = heartbeat_time,
        connection_status = 'ONLINE'
    where id = current_connection.id;
  end if;

  return registration.laptop_id;
end;
$$;

revoke all on function public.record_device_heartbeat(text, text) from public, anon, authenticated;
grant execute on function public.record_device_heartbeat(text, text) to service_role;

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
  set connection_ended_at = last_heartbeat_at + interval '3 minutes',
      connection_status = 'OFFLINE'
  where connection_ended_at is null
    and last_heartbeat_at < now() - interval '3 minutes';

  get diagnostics closed_count = row_count;
  return closed_count;
end;
$$;

revoke all on function public.close_stale_device_connections() from public, anon;
grant execute on function public.close_stale_device_connections() to authenticated;
