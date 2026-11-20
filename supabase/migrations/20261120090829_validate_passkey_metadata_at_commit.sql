-- GoTrue writes provider metadata in a second statement in the same transaction.
-- Validate the final stored row, including on subsequent metadata changes.
create function cashew_private.check_committed_identity() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (
    select 1 from auth.users u left join public.cashew_passkeys p on p.owner_id = u.id
    where u.id=new.id and lower(u.email) like '%@passkey.cashew.invalid'
      and (p.owner_id is null or p.legacy or u.email <> u.id::text || '@passkey.cashew.invalid'
        or u.raw_app_meta_data->>'cashew_passkey' is distinct from u.id::text)
  ) then raise exception 'Invalid internal passkey identity'; end if;
  return null;
end;
$$;
revoke all on function cashew_private.check_committed_identity() from public, anon, authenticated;
create constraint trigger cashew_committed_identity after insert or update on auth.users
  deferrable initially deferred for each row execute function cashew_private.check_committed_identity();

-- The immediate check still requires a server-created reservation for the exact UUID.
create or replace function cashew_private.check_internal_identity() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if lower(new.email) like '%@passkey.cashew.invalid' and not exists (
    select 1 from public.cashew_passkeys p where p.owner_id = new.id and not p.legacy
      and new.email = new.id::text || '@passkey.cashew.invalid'
  ) then
    raise exception 'Reserved account identifier';
  end if;
  return new;
end;
$$;
revoke all on function cashew_private.check_internal_identity() from public, anon, authenticated;
