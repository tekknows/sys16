alter table public.website_blocking_rules
  add column if not exists schedule_id uuid references public.blocking_schedules(id) on delete cascade;

create index if not exists idx_website_blocking_rules_schedule
  on public.website_blocking_rules (schedule_id);

alter table public.blocking_schedules enable row level security;
drop policy if exists "blocking_schedules_read_authenticated" on public.blocking_schedules;
create policy "blocking_schedules_read_authenticated" on public.blocking_schedules
  for select to authenticated using (true);
drop policy if exists "blocking_schedules_manage_support" on public.blocking_schedules;
create policy "blocking_schedules_manage_support" on public.blocking_schedules
  for all to authenticated
  using (public.is_support_staff())
  with check (public.is_support_staff());

alter table public.blocking_schedule_assignments enable row level security;
drop policy if exists "blocking_assignments_read_authenticated" on public.blocking_schedule_assignments;
create policy "blocking_assignments_read_authenticated" on public.blocking_schedule_assignments
  for select to authenticated using (true);
drop policy if exists "blocking_assignments_manage_support" on public.blocking_schedule_assignments;
create policy "blocking_assignments_manage_support" on public.blocking_schedule_assignments
  for all to authenticated
  using (public.is_support_staff())
  with check (public.is_support_staff());
