insert into public.ticket_categories (category_name, is_active)
values
  ('Software Problem', true),
  ('Slow Server', true),
  ('404 Not Found', true),
  ('403 Forbidden', true)
on conflict (category_name) do update
set is_active = excluded.is_active,
    updated_at = now();

update public.ticket_categories
set is_active = false,
    updated_at = now()
where category_name in ('Laptop Hardware', 'Laptop Hardware Problem');

notify pgrst, 'reload schema';
