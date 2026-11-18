do $$
begin
  if to_regclass('public.website_usage_logs') is null then
    raise exception 'Cannot enable realtime analytics: public.website_usage_logs does not exist';
  end if;

  if not exists (
    select 1
    from pg_publication
    where pubname = 'supabase_realtime'
  ) then
    raise exception 'Cannot enable realtime analytics: publication supabase_realtime does not exist';
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'website_usage_logs'
  ) then
    execute 'alter publication supabase_realtime add table public.website_usage_logs';
  end if;
end;
$$;
