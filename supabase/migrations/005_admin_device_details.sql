alter table public.laptops
  add column if not exists mac_address text;

create unique index if not exists idx_laptops_mac_address_unique
  on public.laptops (lower(mac_address))
  where mac_address is not null and btrim(mac_address) <> '';

drop policy if exists "profiles_manage_support" on public.profiles;
create policy "profiles_manage_support" on public.profiles
  for update to authenticated
  using (public.is_support_staff())
  with check (public.is_support_staff());
