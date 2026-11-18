insert into public.system_settings (setting_key, setting_value)
values ('analytics_retention_days', '90'::jsonb)
on conflict (setting_key) do nothing;

create index if not exists idx_usage_logs_recorded_at
  on public.website_usage_logs (recorded_at);

create or replace function public.cleanup_website_usage_logs()
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
      then coalesce((setting_value ->> 'value')::integer, 90)
    when jsonb_typeof(setting_value) in ('number', 'string')
      then (setting_value #>> '{}')::integer
    else 90
  end
  into retention_days
  from public.system_settings
  where setting_key = 'analytics_retention_days';

  retention_days := coalesce(retention_days, 90);
  if retention_days < 1 or retention_days > 3650 then
    raise exception 'Analytics retention must be between 1 and 3650 days.';
  end if;

  delete from public.website_usage_logs
  where recorded_at < now() - make_interval(days => retention_days);

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function public.cleanup_website_usage_logs() from public, anon, authenticated;

create extension if not exists pg_cron;

do $$
begin
  if not exists (
    select 1
    from cron.job
    where jobname = 'loctiv-analytics-retention'
  ) then
    perform cron.schedule(
      'loctiv-analytics-retention',
      '15 0 * * *',
      'select public.cleanup_website_usage_logs();'
    );
  end if;
end;
$$;
