alter table public.website_blocking_rules
  add column if not exists schedule_id uuid references public.blocking_schedules(id) on delete cascade;

with normalized_schedules as (
  select
    id,
    lower(regexp_replace(regexp_replace(regexp_replace(trim(name), '^https?://', ''), '^www\.', ''), '/.*$', '')) as normalized_domain
  from public.blocking_schedules
),
unique_schedule_domains as (
  select normalized_domain, (array_agg(id order by id))[1] as schedule_id
  from normalized_schedules
  group by normalized_domain
  having count(*) = 1
)
update public.website_blocking_rules rule
set schedule_id = unique_schedule_domains.schedule_id
from unique_schedule_domains
where rule.schedule_id is null
  and lower(regexp_replace(regexp_replace(regexp_replace(trim(rule.domain), '^https?://', ''), '^www\.', ''), '/.*$', '')) = unique_schedule_domains.normalized_domain;

create index if not exists idx_website_blocking_rules_schedule
  on public.website_blocking_rules (schedule_id);
