update public.blocking_schedules
set timezone = 'Asia/Manila'
where timezone is distinct from 'Asia/Manila';

insert into public.system_settings (setting_key, setting_value)
values ('timezone', '{"value":"Asia/Manila"}'::jsonb)
on conflict (setting_key) do update
set setting_value = '{"value":"Asia/Manila"}'::jsonb,
    updated_at = now();
