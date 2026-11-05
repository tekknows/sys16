-- MINDLOCK ticket conversations, status workflow, privacy controls, and usage data.

alter type public.ticket_status add value if not exists 'Assigned';
alter type public.ticket_status add value if not exists 'Waiting for IT';

alter table public.tickets
  add column if not exists priority text not null default 'Normal'
    check (priority in ('Low', 'Normal', 'High', 'Urgent'));

alter table public.ticket_messages
  add column if not exists sender_role text not null default 'Employee',
  add column if not exists sender_name text not null default '',
  add column if not exists is_read boolean not null default false,
  add column if not exists read_at timestamptz;

alter table public.tickets
  drop constraint if exists tickets_profile_id_fkey,
  add constraint tickets_profile_id_fkey foreign key (profile_id)
    references public.profiles(id) on delete restrict;

alter table public.ticket_messages
  drop constraint if exists ticket_messages_sender_id_fkey,
  add constraint ticket_messages_sender_id_fkey foreign key (sender_id)
    references public.profiles(id) on delete restrict;

update public.ticket_messages message
set sender_name = coalesce((select profile.full_name from public.profiles profile where profile.id = message.sender_id), 'User'),
    sender_role = coalesce(
  (select role.role_name::text
   from public.user_roles role
   where role.profile_id = message.sender_id
     and role.revoked_at is null
   order by role.assigned_at desc
   limit 1),
  'Employee'
);

alter table public.ticket_attachments
  add column if not exists message_id uuid references public.ticket_messages(id) on delete set null;

alter table public.website_usage_logs
  add column if not exists bytes_used bigint not null default 0 check (bytes_used >= 0);

create sequence if not exists public.ticket_number_seq;
do $$
declare
  highest_number bigint;
begin
  select coalesce(max(substring(ticket_number from '^MND-([0-9]+)$')::bigint), 0)
    into highest_number
    from public.tickets;
  perform setval('public.ticket_number_seq', greatest(highest_number + 1, 1), false);
end;
$$;
alter table public.tickets
  alter column ticket_number set default ('MND-' || lpad(nextval('public.ticket_number_seq')::text, 6, '0'));

create table if not exists public.ticket_assignments (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  assigned_to uuid not null references public.profiles(id),
  assigned_by uuid not null references public.profiles(id),
  assigned_at timestamptz not null default now(),
  ended_at timestamptz
);

create table if not exists public.ticket_internal_notes (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  author_id uuid not null references public.profiles(id),
  note text not null check (length(trim(note)) > 0),
  created_at timestamptz not null default now()
);

create index if not exists idx_tickets_updated_at on public.tickets(updated_at desc);
create index if not exists idx_tickets_category_status on public.tickets(issue_category, status);
create index if not exists idx_ticket_messages_unread on public.ticket_messages(ticket_id, sender_role, is_read);
create index if not exists idx_ticket_attachments_message on public.ticket_attachments(message_id);
create index if not exists idx_ticket_assignments_ticket on public.ticket_assignments(ticket_id, assigned_at desc);
create index if not exists idx_ticket_notes_ticket on public.ticket_internal_notes(ticket_id, created_at);
create index if not exists idx_usage_logs_domain_recorded on public.website_usage_logs(domain, recorded_at);

create or replace function public.is_support_staff()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.user_roles role
    where role.profile_id = auth.uid()
      and role.revoked_at is null
      and role.role_name in ('Administrator', 'IT Staff')
  );
$$;

create or replace function public.is_administrator()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.user_roles role
    where role.profile_id = auth.uid()
      and role.revoked_at is null
      and role.role_name = 'Administrator'
  );
$$;

create or replace function public.has_ticket_access(target_ticket_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.is_support_staff()
    or exists (
      select 1
      from public.tickets ticket
      where ticket.id = target_ticket_id
        and ticket.profile_id = auth.uid()
    );
$$;

create or replace function public.create_ticket_opening_message()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.ticket_messages (ticket_id, sender_id, sender_name, sender_role, message, is_read)
  select new.id, new.profile_id, profile.full_name, 'Employee', new.description, false
  from public.profiles profile
  where profile.id = new.profile_id;
  return new;
end;
$$;

drop trigger if exists ticket_opening_message on public.tickets;
create trigger ticket_opening_message
after insert on public.tickets
for each row execute function public.create_ticket_opening_message();

create or replace function public.set_ticket_message_sender_name()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  select coalesce(profile.full_name, 'User')
    into new.sender_name
    from public.profiles profile
    where profile.id = new.sender_id;
  return new;
end;
$$;

drop trigger if exists ticket_message_sender_name on public.ticket_messages;
create trigger ticket_message_sender_name
before insert on public.ticket_messages
for each row execute function public.set_ticket_message_sender_name();

create or replace function public.prevent_ticket_message_content_changes()
returns trigger
language plpgsql
as $$
begin
  if new.ticket_id is distinct from old.ticket_id
    or new.sender_id is distinct from old.sender_id
    or new.sender_name is distinct from old.sender_name
    or new.sender_role is distinct from old.sender_role
    or new.message is distinct from old.message
    or new.created_at is distinct from old.created_at then
    raise exception 'Ticket message content is immutable.';
  end if;
  return new;
end;
$$;

drop trigger if exists ticket_message_content_immutable on public.ticket_messages;
create trigger ticket_message_content_immutable
before update on public.ticket_messages
for each row execute function public.prevent_ticket_message_content_changes();

create or replace function public.reopen_own_resolved_ticket(target_ticket_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.tickets
  set status = 'Open'
  where id = target_ticket_id
    and profile_id = auth.uid()
    and status = 'Resolved';
  if not found then
    raise exception 'Ticket is unavailable or is not eligible to reopen.';
  end if;
end;
$$;
grant execute on function public.reopen_own_resolved_ticket(uuid) to authenticated;

create or replace function public.assign_ticket_staff(target_ticket_id uuid, target_profile_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_support_staff() then
    raise exception 'Only authorized support staff can assign tickets.';
  end if;

  perform 1 from public.tickets where id = target_ticket_id for update;
  if not found then
    raise exception 'Ticket not found.';
  end if;

  if target_profile_id is not null and not exists (
    select 1
    from public.user_roles role
    where role.profile_id = target_profile_id
      and role.revoked_at is null
      and role.role_name in ('Administrator', 'IT Staff')
  ) then
    raise exception 'The selected user is not authorized support staff.';
  end if;

  update public.ticket_assignments
  set ended_at = now()
  where ticket_id = target_ticket_id
    and ended_at is null;

  update public.tickets
  set assigned_to = target_profile_id
  where id = target_ticket_id;

  if target_profile_id is not null then
    insert into public.ticket_assignments (ticket_id, assigned_to, assigned_by)
    values (target_ticket_id, target_profile_id, auth.uid());
  end if;
end;
$$;
grant execute on function public.assign_ticket_staff(uuid, uuid) to authenticated;

alter table public.ticket_assignments enable row level security;
alter table public.ticket_internal_notes enable row level security;
alter table public.ticket_attachments enable row level security;
alter table public.website_usage_logs enable row level security;

drop policy if exists "admins_manage_admins" on public.admins;
drop policy if exists "tickets_manage_auth_users" on public.tickets;
drop policy if exists "tickets_select_participant" on public.tickets;
drop policy if exists "tickets_insert_owner" on public.tickets;
drop policy if exists "tickets_update_staff" on public.tickets;
create policy "tickets_select_participant" on public.tickets
  for select using (profile_id = auth.uid() or public.is_support_staff());
create policy "tickets_insert_owner" on public.tickets
  for insert with check (
    profile_id = auth.uid()
    and status = 'Open'
    and priority = 'Normal'
    and assigned_to is null
    and exists (
      select 1 from public.user_roles role
      where role.profile_id = auth.uid()
        and role.role_name = 'Employee'
        and role.revoked_at is null
    )
    and exists (
      select 1 from public.employees employee
      where employee.id = tickets.employee_id
        and employee.profile_id = auth.uid()
    )
    and (
      laptop_id is null
      or exists (
        select 1
        from public.laptop_assignments assignment
        join public.employees employee on employee.id = assignment.employee_id
        where assignment.laptop_id = tickets.laptop_id
          and assignment.status = 'Active'
          and employee.profile_id = auth.uid()
      )
    )
  );
create policy "tickets_update_staff" on public.tickets
  for update using (public.is_support_staff())
  with check (public.is_support_staff());

drop policy if exists "ticket_messages_select_participant" on public.ticket_messages;
drop policy if exists "ticket_messages_insert_participant" on public.ticket_messages;
drop policy if exists "ticket_messages_update_participant" on public.ticket_messages;
create policy "ticket_messages_select_participant" on public.ticket_messages
  for select using (public.has_ticket_access(ticket_id));
create policy "ticket_messages_insert_participant" on public.ticket_messages
  for insert with check (
    sender_id = auth.uid()
    and public.has_ticket_access(ticket_id)
    and exists (
      select 1 from public.user_roles role
      where role.profile_id = auth.uid()
        and role.role_name::text = sender_role
        and role.revoked_at is null
    )
  );
create policy "ticket_messages_update_participant" on public.ticket_messages
  for update using (public.has_ticket_access(ticket_id))
  with check (public.has_ticket_access(ticket_id));

drop policy if exists "ticket_attachments_select_participant" on public.ticket_attachments;
drop policy if exists "ticket_attachments_insert_participant" on public.ticket_attachments;
create policy "ticket_attachments_select_participant" on public.ticket_attachments
  for select using (public.has_ticket_access(ticket_id));
create policy "ticket_attachments_insert_participant" on public.ticket_attachments
  for insert with check (uploaded_by = auth.uid() and public.has_ticket_access(ticket_id));

drop policy if exists "ticket_assignments_select_staff" on public.ticket_assignments;
drop policy if exists "ticket_assignments_insert_staff" on public.ticket_assignments;
create policy "ticket_assignments_select_staff" on public.ticket_assignments
  for select using (public.is_support_staff());
create policy "ticket_assignments_insert_staff" on public.ticket_assignments
  for insert with check (
    assigned_by = auth.uid()
    and public.is_support_staff()
    and exists (
      select 1 from public.user_roles role
      where role.profile_id = assigned_to
        and role.role_name in ('Administrator', 'IT Staff')
        and role.revoked_at is null
    )
  );

drop policy if exists "ticket_internal_notes_select_staff" on public.ticket_internal_notes;
drop policy if exists "ticket_internal_notes_insert_staff" on public.ticket_internal_notes;
create policy "ticket_internal_notes_select_staff" on public.ticket_internal_notes
  for select using (public.is_support_staff());
create policy "ticket_internal_notes_insert_staff" on public.ticket_internal_notes
  for insert with check (author_id = auth.uid() and public.is_support_staff());

drop policy if exists "usage_logs_select_authorized" on public.website_usage_logs;
create policy "usage_logs_select_authorized" on public.website_usage_logs
  for select using (profile_id = auth.uid() or public.is_support_staff());

drop policy if exists "profiles_select_support_staff" on public.profiles;
create policy "profiles_select_support_staff" on public.profiles
  for select using (id = auth.uid() or public.is_support_staff());

drop policy if exists "employees_select_staff" on public.employees;
create policy "employees_select_staff" on public.employees
  for select using (profile_id = auth.uid() or public.is_support_staff());

drop policy if exists "laptop_assignments_select_participant" on public.laptop_assignments;
create policy "laptop_assignments_select_participant" on public.laptop_assignments
  for select using (
    public.is_support_staff()
    or exists (
      select 1 from public.employees employee
      where employee.id = laptop_assignments.employee_id
        and employee.profile_id = auth.uid()
    )
  );

drop policy if exists "laptops_view_auth_users" on public.laptops;
create policy "laptops_view_staff_or_assigned" on public.laptops
  for select using (
    public.is_support_staff()
    or exists (
      select 1 from public.laptop_assignments assignment
      join public.employees employee on employee.id = assignment.employee_id
      where assignment.laptop_id = laptops.id
        and assignment.status = 'Active'
        and employee.profile_id = auth.uid()
    )
  );

drop policy if exists "user_roles_select_own" on public.user_roles;
drop policy if exists "user_roles_manage_admin" on public.user_roles;
create policy "user_roles_select_own" on public.user_roles
  for select using (profile_id = auth.uid() or public.is_support_staff());
create policy "user_roles_manage_admin" on public.user_roles
  for all using (public.is_administrator())
  with check (public.is_administrator());

drop policy if exists "ticket_storage_read" on storage.objects;
drop policy if exists "ticket_storage_insert" on storage.objects;
drop policy if exists "ticket_storage_delete" on storage.objects;
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ticket-attachments', 'ticket-attachments', false, 10485760, array['application/pdf', 'image/png', 'image/jpeg', 'text/plain'])
on conflict (id) do nothing;
create policy "ticket_storage_read" on storage.objects
  for select using (
    bucket_id = 'ticket-attachments'
    and case when split_part(name, '/', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then public.has_ticket_access(split_part(name, '/', 1)::uuid)
      else false
    end
  );
create policy "ticket_storage_insert" on storage.objects
  for insert with check (
    bucket_id = 'ticket-attachments'
    and case when split_part(name, '/', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then public.has_ticket_access(split_part(name, '/', 1)::uuid)
      else false
    end
  );
create policy "ticket_storage_delete" on storage.objects
  for delete using (
    bucket_id = 'ticket-attachments'
    and public.is_support_staff()
  );

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'tickets'
    ) then
      execute 'alter publication supabase_realtime add table public.tickets';
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'ticket_messages'
    ) then
      execute 'alter publication supabase_realtime add table public.ticket_messages';
    end if;
  end if;
end;
$$;
