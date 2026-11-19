insert into public.ticket_categories (category_name, is_active)
values
  ('Account and Sign-in', true),
  ('Browser Extension', true),
  ('Website Blocking and Access', true),
  ('Laptop Hardware', true),
  ('Network and Internet', true),
  ('Application and Software', true),
  ('Performance and Slowness', true),
  ('Security Concern', true),
  ('Other Technical Issue', true)
on conflict (category_name) do update
set is_active = excluded.is_active,
    updated_at = now();

update public.ticket_categories
set is_active = false,
    updated_at = now()
where category_name in (
  'Browser Extension Issue',
  'Website Blocking Issue',
  'Laptop Hardware Problem',
  'Internet Connection',
  'Account and Login',
  'Software Installation'
);

alter table public.ticket_categories enable row level security;
revoke all on public.ticket_categories from public, anon;
grant select, insert, update, delete on public.ticket_categories to authenticated;

drop policy if exists "ticket_categories_read_active" on public.ticket_categories;
create policy "ticket_categories_read_active" on public.ticket_categories
  for select to authenticated
  using (is_active or public.is_support_staff());

drop policy if exists "ticket_categories_manage_support" on public.ticket_categories;
create policy "ticket_categories_manage_support" on public.ticket_categories
  for all to authenticated
  using (public.is_support_staff())
  with check (public.is_support_staff());

notify pgrst, 'reload schema';
