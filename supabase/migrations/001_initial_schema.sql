-- MINDLOCK initial database schema
-- Purpose: create the core tables required by the admin dashboard, browser extension,
-- and ticketing workflows. This is a starter migration intended for Supabase PostgreSQL.

create extension if not exists pgcrypto;

create type public.user_role_name as enum ('Administrator', 'IT Staff', 'Employee');
create type public.assignment_status as enum ('Active', 'Terminated', 'Pending');
create type public.laptop_status as enum ('Available', 'Assigned', 'Maintenance', 'Retired');
create type public.ticket_status as enum ('Open', 'In Progress', 'Waiting for Employee', 'Resolved', 'Closed');
create type public.request_status as enum ('Pending', 'Approved', 'Rejected', 'Completed', 'Cancelled');
create type public.policy_status as enum ('Enabled', 'Disabled');

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  email text not null unique,
  employee_id text unique,
  department text,
  position text,
  avatar_url text,
  account_status text not null default 'Active',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.employees (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null unique references public.profiles(id) on delete cascade,
  user_id text not null unique default ('USR-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))),
  employee_code text not null unique,
  department text,
  position text,
  active boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.admins (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null unique references public.profiles(id) on delete cascade,
  is_super_admin boolean not null default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.user_roles (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  role_name public.user_role_name not null,
  assigned_by uuid references public.profiles(id),
  assigned_at timestamptz default now(),
  revoked_at timestamptz,
  unique (profile_id, role_name)
);

create table if not exists public.role_permissions (
  id uuid primary key default gen_random_uuid(),
  role_name public.user_role_name not null,
  permission_name text not null,
  allowed boolean not null default true,
  created_at timestamptz default now(),
  unique (role_name, permission_name)
);

create table if not exists public.laptops (
  id uuid primary key default gen_random_uuid(),
  laptop_id text not null unique,
  device_registration_id text,
  device_name text,
  manufacturer text,
  model text,
  serial_number text,
  operating_system text,
  browser text,
  extension_version text,
  registration_date timestamptz default now(),
  status public.laptop_status not null default 'Available',
  active boolean not null default true,
  last_sync_at timestamptz,
  last_reported_activity timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.laptop_assignments (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  laptop_id uuid not null references public.laptops(id) on delete cascade,
  assigned_by uuid references public.profiles(id),
  status public.assignment_status not null default 'Active',
  assigned_at timestamptz default now(),
  ended_at timestamptz,
  reason text,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.device_registrations (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references public.profiles(id) on delete cascade,
  laptop_id uuid references public.laptops(id) on delete set null,
  registration_id text not null unique,
  device_name text,
  browser_family text,
  extension_version text,
  last_heartbeat_at timestamptz,
  policy_version text,
  is_active boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.website_blocking_rules (
  id uuid primary key default gen_random_uuid(),
  domain text not null,
  reason text,
  category text,
  is_active boolean not null default true,
  created_by uuid references public.profiles(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.blocking_schedules (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  scope text not null default 'Global',
  start_time time not null,
  end_time time not null,
  days_of_week text[] not null default '{}',
  starts_on date,
  expires_on date,
  is_active boolean not null default true,
  created_by uuid references public.profiles(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.blocking_schedule_assignments (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references public.blocking_schedules(id) on delete cascade,
  employee_id uuid references public.employees(id) on delete cascade,
  laptop_id uuid references public.laptops(id) on delete cascade,
  assigned_by uuid references public.profiles(id),
  created_at timestamptz default now(),
  unique (schedule_id, employee_id, laptop_id)
);

create table if not exists public.global_policies (
  id uuid primary key default gen_random_uuid(),
  policy_name text not null default 'Global Incognito Blocker',
  policy_status public.policy_status not null default 'Disabled',
  is_active boolean not null default false,
  last_synced_at timestamptz,
  sync_status text,
  affected_laptop_count integer not null default 0,
  updated_by uuid references public.profiles(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.device_policy_status (
  id uuid primary key default gen_random_uuid(),
  laptop_id uuid not null references public.laptops(id) on delete cascade,
  policy_name text not null,
  policy_enabled boolean not null default false,
  enforced_at timestamptz,
  sync_error text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (laptop_id, policy_name)
);

create table if not exists public.website_usage_logs (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid references public.employees(id) on delete set null,
  profile_id uuid references public.profiles(id) on delete set null,
  laptop_id uuid references public.laptops(id) on delete set null,
  domain text not null,
  url text,
  category text,
  visit_count integer not null default 1,
  total_seconds integer not null default 0,
  recorded_at timestamptz default now(),
  created_at timestamptz default now()
);

create table if not exists public.tickets (
  id uuid primary key default gen_random_uuid(),
  ticket_number text not null unique,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  employee_id uuid references public.employees(id) on delete set null,
  laptop_id uuid references public.laptops(id) on delete set null,
  subject text not null,
  issue_category text not null,
  description text not null,
  assigned_to uuid references public.profiles(id),
  status public.ticket_status not null default 'Open',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.ticket_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  message text not null,
  created_at timestamptz default now()
);

create table if not exists public.ticket_categories (
  id uuid primary key default gen_random_uuid(),
  category_name text not null unique,
  is_active boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.ticket_attachments (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  file_name text not null,
  storage_path text not null,
  content_type text,
  uploaded_by uuid references public.profiles(id),
  created_at timestamptz default now()
);

create table if not exists public.laptop_change_requests (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid references public.tickets(id),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  request_type text not null,
  current_laptop_id uuid references public.laptops(id),
  reason text not null,
  status public.request_status not null default 'Pending',
  administrator_remarks text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.update_logs (
  id uuid primary key default gen_random_uuid(),
  version text not null,
  title text not null,
  description text,
  release_date date,
  new_features text,
  bug_fixes text,
  published_by uuid references public.profiles(id),
  created_at timestamptz default now()
);

create table if not exists public.change_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id),
  action text not null,
  module_name text not null,
  affected_record_id text,
  previous_value text,
  new_value text,
  created_at timestamptz default now()
);

create table if not exists public.system_settings (
  id uuid primary key default gen_random_uuid(),
  setting_key text not null unique,
  setting_value jsonb,
  updated_by uuid references public.profiles(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  body text not null,
  is_read boolean not null default false,
  link text,
  created_at timestamptz default now()
);

create table if not exists public.device_heartbeats (
  id uuid primary key default gen_random_uuid(),
  laptop_id uuid not null references public.laptops(id) on delete cascade,
  device_registration_id text,
  heartbeat_at timestamptz default now(),
  last_synced_policy_version text,
  sync_error text,
  created_at timestamptz default now()
);

create index if not exists idx_profiles_email on public.profiles(email);
create index if not exists idx_employees_employee_code on public.employees(employee_code);
create index if not exists idx_employees_user_id on public.employees(user_id);
create index if not exists idx_laptops_status on public.laptops(status, active);
create index if not exists idx_assignments_active on public.laptop_assignments(status, employee_id, laptop_id);
create index if not exists idx_tickets_status on public.tickets(status);
create index if not exists idx_ticket_messages_ticket on public.ticket_messages(ticket_id, created_at);
create index if not exists idx_usage_logs_profile on public.website_usage_logs(profile_id, recorded_at);
create index if not exists idx_change_logs_module on public.change_logs(module_name, created_at);

alter table public.profiles enable row level security;
alter table public.employees enable row level security;
alter table public.admins enable row level security;
alter table public.user_roles enable row level security;
alter table public.laptops enable row level security;
alter table public.laptop_assignments enable row level security;
alter table public.tickets enable row level security;
alter table public.ticket_messages enable row level security;
alter table public.change_logs enable row level security;
alter table public.system_settings enable row level security;
alter table public.notifications enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id);

drop policy if exists "employees_select_self" on public.employees;
create policy "employees_select_self" on public.employees
  for select using (profile_id = auth.uid());

drop policy if exists "admins_manage_admins" on public.admins;
create policy "admins_manage_admins" on public.admins
  for all using (true) with check (true);

drop policy if exists "laptops_view_auth_users" on public.laptops;
create policy "laptops_view_auth_users" on public.laptops
  for select using (auth.role() = 'authenticated');

drop policy if exists "tickets_manage_auth_users" on public.tickets;
create policy "tickets_manage_auth_users" on public.tickets
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

drop policy if exists "notifications_manage_self" on public.notifications;
create policy "notifications_manage_self" on public.notifications
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger set_profiles_updated_at before update on public.profiles
for each row execute function public.set_updated_at();

create trigger set_employees_updated_at before update on public.employees
for each row execute function public.set_updated_at();

create trigger set_laptops_updated_at before update on public.laptops
for each row execute function public.set_updated_at();

create trigger set_tickets_updated_at before update on public.tickets
for each row execute function public.set_updated_at();

create trigger set_settings_updated_at before update on public.system_settings
for each row execute function public.set_updated_at();

insert into public.role_permissions (role_name, permission_name, allowed)
values
  ('Administrator', 'dashboard:view', true),
  ('Administrator', 'employee:manage', true),
  ('Administrator', 'laptop:manage', true),
  ('Administrator', 'ticket:manage', true),
  ('Administrator', 'schedule:manage', true),
  ('IT Staff', 'ticket:reply', true),
  ('IT Staff', 'ticket:view_assigned', true),
  ('IT Staff', 'laptop:view', true),
  ('Employee', 'ticket:create', true),
  ('Employee', 'ticket:view_own', true),
  ('Employee', 'website:usage_view_own', true)
on conflict (role_name, permission_name) do nothing;

insert into public.ticket_categories (category_name, is_active)
values
  ('Browser Extension Issue', true),
  ('Website Blocking Issue', true),
  ('Laptop Hardware Problem', true),
  ('Internet Connection', true),
  ('Account and Login', true),
  ('Software Installation', true),
  ('Other Technical Issue', true)
on conflict (category_name) do nothing;

insert into public.system_settings (setting_key, setting_value)
values
  ('company_name', '{"value":"LOCTIV"}'::jsonb),
  ('timezone', '{"value":"UTC"}'::jsonb),
  ('ticket_retention_days', '{"value":90}'::jsonb),
  ('global_incognito_policy', '{"enabled":false}'::jsonb),
  ('dashboard_accent', '{"value":"#2563eb"}'::jsonb),
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
