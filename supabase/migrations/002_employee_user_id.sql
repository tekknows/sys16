-- Add human-readable user IDs to existing employee records.
alter table public.employees
  add column if not exists user_id text;

update public.employees
set user_id = 'USR-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))
where user_id is null;

alter table public.employees
  alter column user_id set default ('USR-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))),
  alter column user_id set not null;

create unique index if not exists idx_employees_user_id
  on public.employees(user_id);

create unique index if not exists idx_laptop_assignments_one_active_per_laptop
  on public.laptop_assignments(laptop_id)
  where status = 'Active';

create unique index if not exists idx_laptop_assignments_one_active_per_employee
  on public.laptop_assignments(employee_id)
  where status = 'Active';
