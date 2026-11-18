do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
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
