drop policy if exists "ticket_messages_insert_participant" on public.ticket_messages;
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
    and (
      sender_role <> 'Employee'
      or exists (
        select 1 from public.tickets ticket
        where ticket.id = ticket_id and ticket.status <> 'Closed'
      )
    )
  );

drop policy if exists "ticket_attachments_insert_participant" on public.ticket_attachments;
create policy "ticket_attachments_insert_participant" on public.ticket_attachments
  for insert with check (
    uploaded_by = auth.uid()
    and public.has_ticket_access(ticket_id)
    and (
      public.is_support_staff()
      or exists (
        select 1 from public.tickets ticket
        where ticket.id = ticket_id and ticket.status <> 'Closed'
      )
    )
  );

drop policy if exists "ticket_storage_insert" on storage.objects;
create policy "ticket_storage_insert" on storage.objects
  for insert with check (
    bucket_id = 'ticket-attachments'
    and case when split_part(name, '/', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then public.has_ticket_access(split_part(name, '/', 1)::uuid)
        and (
          public.is_support_staff()
          or exists (
            select 1 from public.tickets ticket
            where ticket.id = split_part(name, '/', 1)::uuid
              and ticket.status <> 'Closed'
          )
        )
      else false
    end
  );

update public.device_registrations registration
set is_active = false,
    revoked_at = coalesce(registration.revoked_at, now())
where registration.is_active
  and not exists (
    select 1
    from public.laptop_assignments assignment
    join public.employees employee on employee.id = assignment.employee_id
    where assignment.laptop_id = registration.laptop_id
      and assignment.status = 'Active'
      and (assignment.expires_at is null or assignment.expires_at > now())
      and employee.active
  );

update public.device_connection_logs connection
set connection_ended_at = coalesce(connection.connection_ended_at, now()),
    connection_status = 'OFFLINE'
where connection.connection_ended_at is null
  and not exists (
    select 1
    from public.laptop_assignments assignment
    join public.employees employee on employee.id = assignment.employee_id
    where assignment.laptop_id = connection.laptop_id
      and assignment.status = 'Active'
      and (assignment.expires_at is null or assignment.expires_at > now())
      and employee.active
  );

update public.laptops laptop
set device_registration_id = null
where not exists (
  select 1
  from public.device_registrations registration
  where registration.laptop_id = laptop.id and registration.is_active
);

create or replace function public.revoke_unassigned_laptop_registration()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  affected_laptop_id uuid;
begin
  if tg_op = 'DELETE' then
    affected_laptop_id := old.laptop_id;
  else
    affected_laptop_id := new.laptop_id;
  end if;

  if not exists (
    select 1
    from public.laptop_assignments assignment
    join public.employees employee on employee.id = assignment.employee_id
    where assignment.laptop_id = affected_laptop_id
      and assignment.status = 'Active'
      and (assignment.expires_at is null or assignment.expires_at > now())
      and employee.active
  ) then
    update public.device_registrations
    set is_active = false,
        revoked_at = coalesce(revoked_at, now())
    where laptop_id = affected_laptop_id and is_active;

    update public.device_connection_logs
    set connection_ended_at = coalesce(connection_ended_at, now()),
        connection_status = 'OFFLINE'
    where laptop_id = affected_laptop_id and connection_ended_at is null;

    update public.laptops
    set device_registration_id = null
    where id = affected_laptop_id;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists laptop_assignment_revoke_unassigned_registration on public.laptop_assignments;
create trigger laptop_assignment_revoke_unassigned_registration
  after update of status, expires_at or delete on public.laptop_assignments
  for each row
  execute function public.revoke_unassigned_laptop_registration();

revoke all on function public.revoke_unassigned_laptop_registration() from public, anon, authenticated;
