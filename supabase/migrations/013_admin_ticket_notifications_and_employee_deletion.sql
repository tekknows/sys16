alter table public.tickets
  alter column profile_id drop not null,
  drop constraint if exists tickets_profile_id_fkey;
alter table public.tickets
  add constraint tickets_profile_id_fkey foreign key (profile_id)
    references public.profiles(id) on delete set null;

alter table public.tickets
  drop constraint if exists tickets_assigned_to_fkey;
alter table public.tickets
  add constraint tickets_assigned_to_fkey foreign key (assigned_to)
    references public.profiles(id) on delete set null;

alter table public.ticket_messages
  alter column sender_id drop not null,
  drop constraint if exists ticket_messages_sender_id_fkey;
alter table public.ticket_messages
  add constraint ticket_messages_sender_id_fkey foreign key (sender_id)
    references public.profiles(id) on delete set null;

alter table public.ticket_attachments
  drop constraint if exists ticket_attachments_uploaded_by_fkey;
alter table public.ticket_attachments
  add constraint ticket_attachments_uploaded_by_fkey foreign key (uploaded_by)
    references public.profiles(id) on delete set null;

alter table public.ticket_assignments
  alter column assigned_to drop not null,
  alter column assigned_by drop not null,
  drop constraint if exists ticket_assignments_assigned_to_fkey,
  drop constraint if exists ticket_assignments_assigned_by_fkey;
alter table public.ticket_assignments
  add constraint ticket_assignments_assigned_to_fkey foreign key (assigned_to)
    references public.profiles(id) on delete set null,
  add constraint ticket_assignments_assigned_by_fkey foreign key (assigned_by)
    references public.profiles(id) on delete set null;

alter table public.ticket_internal_notes
  alter column author_id drop not null,
  drop constraint if exists ticket_internal_notes_author_id_fkey;
alter table public.ticket_internal_notes
  add constraint ticket_internal_notes_author_id_fkey foreign key (author_id)
    references public.profiles(id) on delete set null;

alter table public.user_roles
  drop constraint if exists user_roles_assigned_by_fkey;
alter table public.user_roles
  add constraint user_roles_assigned_by_fkey foreign key (assigned_by)
    references public.profiles(id) on delete set null;

alter table public.laptop_assignments
  drop constraint if exists laptop_assignments_assigned_by_fkey;
alter table public.laptop_assignments
  add constraint laptop_assignments_assigned_by_fkey foreign key (assigned_by)
    references public.profiles(id) on delete set null;

alter table public.website_blocking_rules
  drop constraint if exists website_blocking_rules_created_by_fkey;
alter table public.website_blocking_rules
  add constraint website_blocking_rules_created_by_fkey foreign key (created_by)
    references public.profiles(id) on delete set null;

alter table public.blocking_schedules
  drop constraint if exists blocking_schedules_created_by_fkey;
alter table public.blocking_schedules
  add constraint blocking_schedules_created_by_fkey foreign key (created_by)
    references public.profiles(id) on delete set null;

alter table public.blocking_schedule_assignments
  drop constraint if exists blocking_schedule_assignments_assigned_by_fkey;
alter table public.blocking_schedule_assignments
  add constraint blocking_schedule_assignments_assigned_by_fkey foreign key (assigned_by)
    references public.profiles(id) on delete set null;

alter table public.global_policies
  drop constraint if exists global_policies_updated_by_fkey;
alter table public.global_policies
  add constraint global_policies_updated_by_fkey foreign key (updated_by)
    references public.profiles(id) on delete set null;

alter table public.update_logs
  drop constraint if exists update_logs_published_by_fkey;
alter table public.update_logs
  add constraint update_logs_published_by_fkey foreign key (published_by)
    references public.profiles(id) on delete set null;

alter table public.change_logs
  drop constraint if exists change_logs_user_id_fkey;
alter table public.change_logs
  add constraint change_logs_user_id_fkey foreign key (user_id)
    references public.profiles(id) on delete set null;

alter table public.system_settings
  drop constraint if exists system_settings_updated_by_fkey;
alter table public.system_settings
  add constraint system_settings_updated_by_fkey foreign key (updated_by)
    references public.profiles(id) on delete set null;

alter table public.device_registrations
  drop constraint if exists device_registrations_registered_by_fkey,
  drop constraint if exists device_registrations_revoked_by_fkey;
alter table public.device_registrations
  add constraint device_registrations_registered_by_fkey foreign key (registered_by)
    references public.profiles(id) on delete set null,
  add constraint device_registrations_revoked_by_fkey foreign key (revoked_by)
    references public.profiles(id) on delete set null;

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
  select distinct ur.profile_id,
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

create or replace function public.notify_admins_of_ticket_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  update_detail text;
begin
  if old.status is distinct from new.status and old.assigned_to is distinct from new.assigned_to then
    update_detail := 'status changed to ' || new.status::text || ' and assignment updated';
  elsif old.status is distinct from new.status then
    update_detail := 'status changed to ' || new.status::text;
  else
    update_detail := 'assignment updated';
  end if;

  insert into public.notifications (user_id, title, body, link)
  select distinct ur.profile_id,
         'Ticket updated',
         'Ticket ' || new.ticket_number || ': ' || update_detail || '.',
         'tickets'
  from public.user_roles ur
  where ur.role_name = 'Administrator'
    and ur.revoked_at is null
    and ur.profile_id is distinct from auth.uid();

  return new;
end;
$$;

drop trigger if exists tickets_notify_admins_of_update on public.tickets;
create trigger tickets_notify_admins_of_update
after update of status, assigned_to on public.tickets
for each row
when (old.status is distinct from new.status or old.assigned_to is distinct from new.assigned_to)
execute function public.notify_admins_of_ticket_update();

create or replace function public.notify_admins_of_staff_reply()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.sender_role <> 'IT Staff' then
    return new;
  end if;

  insert into public.notifications (user_id, title, body, link)
  select distinct ur.profile_id,
         'IT staff replied to a ticket',
         'IT staff replied to ticket ' || ticket.ticket_number || ': ' || ticket.subject,
         'tickets'
  from public.user_roles ur
  cross join public.tickets ticket
  where ticket.id = new.ticket_id
    and ur.role_name = 'Administrator'
    and ur.revoked_at is null
    and ur.profile_id is distinct from new.sender_id;

  return new;
end;
$$;

drop trigger if exists ticket_messages_notify_admins_of_staff_reply on public.ticket_messages;
create trigger ticket_messages_notify_admins_of_staff_reply
after insert on public.ticket_messages
for each row execute function public.notify_admins_of_staff_reply();
