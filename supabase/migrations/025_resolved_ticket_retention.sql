insert into public.system_settings (setting_key, setting_value)
values ('resolved_ticket_cleanup_days', '3'::jsonb)
on conflict (setting_key) do nothing;

create index if not exists idx_tickets_resolved_closed_updated_at
  on public.tickets (updated_at)
  where status in ('Resolved', 'Closed');

alter table public.laptop_change_requests
  drop constraint if exists laptop_change_requests_ticket_id_fkey;
alter table public.laptop_change_requests
  add constraint laptop_change_requests_ticket_id_fkey
  foreign key (ticket_id) references public.tickets(id) on delete set null;

create or replace function public.cleanup_resolved_closed_tickets()
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  retention_days integer;
  deleted_count bigint;
begin
  select case
    when jsonb_typeof(setting_value) = 'object'
      then coalesce((setting_value ->> 'value')::integer, 3)
    when jsonb_typeof(setting_value) in ('number', 'string')
      then (setting_value #>> '{}')::integer
    else 3
  end
  into retention_days
  from public.system_settings
  where setting_key = 'resolved_ticket_cleanup_days';

  retention_days := coalesce(retention_days, 3);
  if retention_days < 1 or retention_days > 3650 then
    raise exception 'Resolved/closed ticket retention must be between 1 and 3650 days.';
  end if;

  delete from public.tickets
  where status in ('Resolved', 'Closed')
    and updated_at < now() - make_interval(days => retention_days);

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function public.cleanup_resolved_closed_tickets() from public, anon, authenticated;

create extension if not exists pg_cron;

do $$
declare
  existing_job_id bigint;
begin
  select jobid
  into existing_job_id
  from cron.job
  where jobname = 'mindlock-resolved-ticket-retention';

  if existing_job_id is not null then
    perform cron.unschedule(existing_job_id);
  end if;

  perform cron.schedule(
    'mindlock-resolved-ticket-retention',
    '30 0 * * *',
    'select public.cleanup_resolved_closed_tickets();'
  );
end;
$$;

notify pgrst, 'reload schema';