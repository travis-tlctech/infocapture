-- Just enough of Supabase's own schemas and roles for setup.sql to run on a
-- plain PostgreSQL, used by supabase/test/run.sh. Not for a real project.

create role anon nologin;
create role authenticated nologin;

create schema auth;
create table auth.users (id uuid primary key, email text not null);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create schema storage;
create table storage.buckets (
  id text primary key,
  name text not null,
  public boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text not null,
  owner uuid default auth.uid()
);
alter table storage.objects enable row level security;

grant usage on schema public, auth, storage to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
grant select, insert, update, delete on storage.objects to anon, authenticated;
-- Supabase grants every new public table to both API roles by default;
-- setup.sql has to take that back for anon.
alter default privileges in schema public grant all on tables to anon, authenticated;

-- Two logins: run.sh puts the first on the team, the second stays outside.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'Member@Example.com'),
  ('00000000-0000-0000-0000-00000000000b', 'outsider@example.com');
