alter table public.blocking_schedules
  add column if not exists description text,
  add column if not exists timezone text not null default 'Asia/Manila';

alter table public.blocking_schedules
  drop constraint if exists blocking_schedules_timezone_check;

alter table public.blocking_schedules
  add constraint blocking_schedules_timezone_check
  check (timezone in ('Asia/Manila', 'UTC'));

create index if not exists idx_blocking_schedules_active_window
  on public.blocking_schedules (is_active, starts_on, expires_on);
