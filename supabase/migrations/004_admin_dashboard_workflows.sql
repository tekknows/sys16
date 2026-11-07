create sequence if not exists public.employee_user_id_seq;
do $$
declare
  highest_number bigint;
begin
  select greatest(
      coalesce(max(substring(user_id from '^USR-([0-9]+)$')::bigint), 0),
      coalesce(max(substring(employee_code from '^USR-([0-9]+)$')::bigint), 0)
    )
    into highest_number
    from public.employees;
  if highest_number = 0 then
    perform setval('public.employee_user_id_seq', 1, false);
  else
    perform setval('public.employee_user_id_seq', highest_number, true);
  end if;
end;
$$;

alter table public.employees
  alter column user_id set default ('USR-' || lpad(nextval('public.employee_user_id_seq')::text, 4, '0'));

create or replace function public.assign_employee_code()
returns trigger
language plpgsql
as $$
begin
  if new.employee_code is null or btrim(new.employee_code) = '' then
    new.employee_code := new.user_id;
  end if;
  return new;
end;
$$;

drop trigger if exists assign_employee_code on public.employees;
create trigger assign_employee_code
  before insert on public.employees
  for each row execute function public.assign_employee_code();

create sequence if not exists public.laptop_id_seq;
do $$
declare
  highest_number bigint;
begin
  select max(substring(laptop_id from '^ML-([0-9]+)$')::bigint)
    into highest_number
    from public.laptops;
  if highest_number is null then
    perform setval('public.laptop_id_seq', 1, false);
  else
    perform setval('public.laptop_id_seq', highest_number, true);
  end if;
end;
$$;

alter table public.laptops
  alter column laptop_id set default ('ML-' || lpad(nextval('public.laptop_id_seq')::text, 3, '0'));

alter table public.website_blocking_rules
  add column if not exists start_time time not null default '00:00',
  add column if not exists end_time time not null default '23:59',
  add column if not exists days_of_week text[] not null default array['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

alter table public.website_blocking_rules enable row level security;
drop policy if exists "website_rules_read_authenticated" on public.website_blocking_rules;
create policy "website_rules_read_authenticated" on public.website_blocking_rules
  for select to authenticated using (true);
drop policy if exists "website_rules_manage_support" on public.website_blocking_rules;
create policy "website_rules_manage_support" on public.website_blocking_rules
  for all to authenticated
  using (public.is_support_staff())
  with check (public.is_support_staff());

alter table public.laptop_change_requests enable row level security;
drop policy if exists "change_requests_select_participant" on public.laptop_change_requests;
create policy "change_requests_select_participant" on public.laptop_change_requests
  for select to authenticated
  using (profile_id = auth.uid() or public.is_support_staff());
drop policy if exists "change_requests_insert_self" on public.laptop_change_requests;
create policy "change_requests_insert_self" on public.laptop_change_requests
  for insert to authenticated
  with check (profile_id = auth.uid());
drop policy if exists "change_requests_review_support" on public.laptop_change_requests;
create policy "change_requests_review_support" on public.laptop_change_requests
  for update to authenticated
  using (public.is_support_staff())
  with check (public.is_support_staff());

drop policy if exists "employees_manage_support" on public.employees;
create policy "employees_manage_support" on public.employees
  for all to authenticated
  using (public.is_support_staff())
  with check (public.is_support_staff());
drop policy if exists "laptops_manage_support" on public.laptops;
create policy "laptops_manage_support" on public.laptops
  for all to authenticated
  using (public.is_support_staff())
  with check (public.is_support_staff());
drop policy if exists "assignments_manage_support" on public.laptop_assignments;
create policy "assignments_manage_support" on public.laptop_assignments
  for all to authenticated
  using (public.is_support_staff())
  with check (public.is_support_staff());
drop policy if exists "change_logs_read_support" on public.change_logs;
create policy "change_logs_read_support" on public.change_logs
  for select to authenticated using (public.is_support_staff());
drop policy if exists "change_logs_insert_support" on public.change_logs;
create policy "change_logs_insert_support" on public.change_logs
  for insert to authenticated
  with check (user_id = auth.uid() and public.is_support_staff());
drop policy if exists "user_roles_assign_employee_support" on public.user_roles;
create policy "user_roles_assign_employee_support" on public.user_roles
  for insert to authenticated
  with check (role_name = 'Employee' and public.is_support_staff());
drop policy if exists "user_roles_restore_employee_support" on public.user_roles;
create policy "user_roles_restore_employee_support" on public.user_roles
  for update to authenticated
  using (role_name = 'Employee' and public.is_support_staff())
  with check (role_name = 'Employee' and public.is_support_staff());

create or replace function public.sync_laptop_assignment_status()
returns trigger
language plpgsql
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') and old.status = 'Active' then
    if not exists (
      select 1 from public.laptop_assignments
      where laptop_id = old.laptop_id
        and status = 'Active'
        and id <> old.id
    ) then
      update public.laptops
      set status = 'Available'
      where id = old.laptop_id and status = 'Assigned';
    end if;
  end if;

  if tg_op in ('INSERT', 'UPDATE') and new.status = 'Active' then
    update public.laptops
    set status = 'Assigned'
    where id = new.laptop_id and status = 'Available';
  end if;

  return null;
end;
$$;

drop trigger if exists sync_laptop_assignment_status on public.laptop_assignments;
create trigger sync_laptop_assignment_status
  after insert or update or delete on public.laptop_assignments
  for each row execute function public.sync_laptop_assignment_status();
