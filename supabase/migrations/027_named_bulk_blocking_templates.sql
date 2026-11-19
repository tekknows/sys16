-- Group reusable default domains into named templates for bulk employee assignment.

create table if not exists public.default_blocking_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  is_active boolean not null default true,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint default_blocking_templates_name_check
    check (length(btrim(name)) between 1 and 100)
);

create unique index if not exists idx_default_blocking_templates_name
  on public.default_blocking_templates (lower(btrim(name)));

alter table public.default_blocking_templates enable row level security;
drop policy if exists "default_blocking_templates_read_support" on public.default_blocking_templates;
create policy "default_blocking_templates_read_support" on public.default_blocking_templates
  for select to authenticated using (public.is_support_staff());
drop policy if exists "default_blocking_templates_manage_support" on public.default_blocking_templates;
create policy "default_blocking_templates_manage_support" on public.default_blocking_templates
  for all to authenticated
  using (public.is_support_staff())
  with check (public.is_support_staff());
grant select, insert, update, delete on public.default_blocking_templates to authenticated;

alter table public.default_blocking_websites
  add column if not exists template_id uuid
    references public.default_blocking_templates(id) on delete cascade;

insert into public.default_blocking_templates (name)
select 'Default websites'
where exists (
  select 1
  from public.default_blocking_websites
  where template_id is null
)
on conflict ((lower(btrim(name)))) do nothing;

update public.default_blocking_websites
set template_id = (
  select template.id
  from public.default_blocking_templates template
  where lower(btrim(template.name)) = 'default websites'
  limit 1
)
where template_id is null;

alter table public.default_blocking_websites
  alter column template_id set not null;

drop index if exists public.idx_default_blocking_websites_normalized_domain;
create unique index if not exists idx_default_blocking_websites_template_domain
  on public.default_blocking_websites (
    template_id,
    regexp_replace(lower(btrim(domain)), '^www[.]', '')
  );
create index if not exists idx_default_blocking_websites_template_active
  on public.default_blocking_websites (template_id, is_active);

create or replace function public.save_default_blocking_template(
  p_template_id uuid,
  p_name text,
  p_domains text[]
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_template_id uuid;
  v_input text;
  v_domain text;
  v_domains text[] := array[]::text[];
begin
  if auth.uid() is null or not public.is_support_staff() then
    raise exception 'Support staff access is required.';
  end if;
  if p_name is null or length(btrim(p_name)) not between 1 and 100 then
    raise exception 'Enter a template name between 1 and 100 characters.';
  end if;
  if p_domains is null or cardinality(p_domains) = 0 or cardinality(p_domains) > 100 then
    raise exception 'Add between 1 and 100 website domains to the template.';
  end if;

  foreach v_input in array p_domains
  loop
    v_domain := regexp_replace(
      regexp_replace(
        regexp_replace(lower(btrim(v_input)), '^https?://', ''),
        '^www[.]', ''
      ),
      '[/#?].*$', ''
    );
    if v_domain is null
       or v_domain = ''
       or length(v_domain) > 253
       or v_domain !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?([.][a-z]{2,})+$' then
      raise exception 'Invalid website domain: %', v_domain;
    end if;
    if v_domain = any(v_domains) then
      raise exception 'The template contains the domain % more than once.', v_domain;
    end if;
    v_domains := array_append(v_domains, v_domain);
  end loop;

  if p_template_id is null then
    insert into public.default_blocking_templates (name, created_by)
    values (btrim(p_name), auth.uid())
    returning id into v_template_id;
  else
    update public.default_blocking_templates
    set name = btrim(p_name), updated_at = now()
    where id = p_template_id
    returning id into v_template_id;
    if v_template_id is null then
      raise exception 'The selected website template could not be found.';
    end if;
  end if;

  delete from public.default_blocking_websites
  where template_id = v_template_id;

  insert into public.default_blocking_websites (template_id, domain, created_by)
  select v_template_id, domain, auth.uid()
  from unnest(v_domains) as selected(domain);

  return v_template_id;
end;
$$;

create or replace function public.assign_default_blocking_websites(
  p_employee_id uuid,
  p_template_ids uuid[]
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_domains text[];
  v_active_count integer;
  v_requested_count integer;
begin
  if auth.uid() is null or not public.is_support_staff() then
    raise exception 'Support staff access is required.';
  end if;
  if p_template_ids is null or cardinality(p_template_ids) = 0 or cardinality(p_template_ids) > 100 then
    raise exception 'Select between 1 and 100 website templates.';
  end if;

  select count(distinct selected.id)
    into v_requested_count
  from unnest(p_template_ids) as selected(id);

  select count(*)
    into v_active_count
  from public.default_blocking_templates template
  where template.id = any(p_template_ids)
    and template.is_active;

  if v_active_count <> v_requested_count then
    raise exception 'One or more selected website templates are inactive or no longer available.';
  end if;

  select array_agg(website.domain order by website.domain)
    into v_domains
  from public.default_blocking_websites website
  where website.template_id = any(p_template_ids)
    and website.is_active;

  if v_domains is null or cardinality(v_domains) = 0 then
    raise exception 'The selected website template has no active websites.';
  end if;

  return public._assign_employee_blocking_domains(p_employee_id, v_domains, null);
end;
$$;

revoke all on function public.save_default_blocking_template(uuid, text, text[]) from public, anon;
revoke all on function public.assign_default_blocking_websites(uuid, uuid[]) from public, anon;
grant execute on function public.save_default_blocking_template(uuid, text, text[]) to authenticated;
grant execute on function public.assign_default_blocking_websites(uuid, uuid[]) to authenticated;

notify pgrst, 'reload schema';
