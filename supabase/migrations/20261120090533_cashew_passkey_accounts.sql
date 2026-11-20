create table public.cashew_passkeys (
  owner_id uuid primary key,
  email text not null unique check (email = lower(trim(email))),
  legacy boolean not null,
  credential_id text unique,
  public_key text,
  counter bigint not null default 0,
  check ((credential_id is null) = (public_key is null)),
  check (legacy or credential_id is not null)
);
create table public.cashew_challenges (
  id uuid primary key default gen_random_uuid(),
  challenge text not null,
  action text not null check (action in ('register','login')),
  email text not null,
  owner_id uuid not null,
  legacy boolean not null,
  expires_at timestamptz not null default (now() + interval '5 minutes')
);
create index on public.cashew_challenges (expires_at);
create index on public.cashew_challenges (email, expires_at);
alter table public.cashew_passkeys enable row level security;
alter table public.cashew_challenges enable row level security;
revoke all on public.cashew_passkeys, public.cashew_challenges from public, anon, authenticated;
grant select, insert, update, delete on public.cashew_passkeys, public.cashew_challenges to service_role;

create schema if not exists cashew_private;
revoke all on schema cashew_private from public, anon, authenticated;
create function cashew_private.reserve_legacy_email() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.email is not null and lower(new.email) not like '%@passkey.cashew.invalid' then
    insert into public.cashew_passkeys(owner_id,email,legacy)
      values (new.id,lower(trim(new.email)),true) on conflict do nothing;
  end if;
  return new;
end;
$$;
revoke all on function cashew_private.reserve_legacy_email() from public, anon, authenticated;
create trigger cashew_reserve_email after insert on auth.users
  for each row execute function cashew_private.reserve_legacy_email();
insert into public.cashew_passkeys(owner_id,email,legacy)
select id,lower(trim(email)),true from auth.users where email is not null
on conflict do nothing;
create function cashew_private.check_internal_identity() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if lower(new.email) like '%@passkey.cashew.invalid' and not exists (
    select 1 from public.cashew_passkeys p where p.owner_id = new.id and not p.legacy
      and new.email = new.id::text || '@passkey.cashew.invalid'
      and new.raw_app_meta_data->>'cashew_passkey' = new.id::text
  ) then
    raise exception 'Reserved account identifier';
  end if;
  return new;
end;
$$;
revoke all on function cashew_private.check_internal_identity() from public, anon, authenticated;
create trigger cashew_internal_identity before insert or update of email on auth.users
  for each row execute function cashew_private.check_internal_identity();
create function cashew_private.remove_key() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.cashew_passkeys where owner_id = old.id;
  return old;
end;
$$;
revoke all on function cashew_private.remove_key() from public, anon, authenticated;
create trigger cashew_remove_key after delete on auth.users for each row execute function cashew_private.remove_key();
