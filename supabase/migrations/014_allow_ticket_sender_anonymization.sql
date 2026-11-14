create or replace function public.prevent_ticket_message_content_changes()
returns trigger
language plpgsql
as $$
begin
  if new.ticket_id is distinct from old.ticket_id
    or (new.sender_id is distinct from old.sender_id and new.sender_id is not null)
    or new.sender_name is distinct from old.sender_name
    or new.sender_role is distinct from old.sender_role
    or new.message is distinct from old.message
    or new.created_at is distinct from old.created_at then
    raise exception 'Ticket message content is immutable.';
  end if;
  return new;
end;
$$;
