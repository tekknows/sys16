create or replace function public.notify_admins_of_employee_ticket()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  employee_name text;
begin
  select coalesce(full_name, email) into employee_name
  from public.profiles
  where id = new.profile_id;

  insert into public.notifications (user_id, title, body, link)
  select ur.profile_id,
         'New employee ticket',
         coalesce(employee_name, 'An employee') || ' submitted ticket ' || new.ticket_number || ': ' || new.subject,
         'tickets'
  from public.user_roles ur
  where ur.role_name in ('Administrator', 'IT Staff')
    and ur.revoked_at is null;

  return new;
end;
$$;

drop trigger if exists tickets_notify_admins on public.tickets;
create trigger tickets_notify_admins
after insert on public.tickets
for each row execute function public.notify_admins_of_employee_ticket();
