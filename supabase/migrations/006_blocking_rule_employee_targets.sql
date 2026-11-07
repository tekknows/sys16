alter table public.website_blocking_rules
  add column if not exists target_profile_id uuid references public.employees(profile_id) on delete cascade;

create index if not exists idx_website_blocking_rules_target_profile
  on public.website_blocking_rules (target_profile_id);
