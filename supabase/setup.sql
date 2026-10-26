-- InfoCapture database setup. Run once in the Supabase dashboard:
-- SQL Editor > New query > paste this file > Run. Safe to run again.
--
-- Creates:
--   public.team_members  who may use InfoCapture (add people with
--                        supabase/add-team-member.sql)
--   public.leads         one row per captured contact
--   card-photos          a private storage bucket for card photos
-- Only signed-in team members can read or write either. The publishable key
-- in the app grants nothing on its own.

-- ---------- team ----------

create table if not exists public.team_members (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  added_at timestamptz not null default now()
);

alter table public.team_members enable row level security;

-- Used by every policy below and by the card reader. security definer so it
-- can read team_members whatever that table's own policies say.
create or replace function public.is_team_member()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.team_members where user_id = (select auth.uid()));
$$;

revoke all on function public.is_team_member() from public, anon;
grant execute on function public.is_team_member() to authenticated;

drop policy if exists "Members see their own membership" on public.team_members;
create policy "Members see their own membership" on public.team_members
  for select to authenticated
  using (user_id = (select auth.uid()));

revoke all on public.team_members from anon, authenticated;
grant select on public.team_members to authenticated;

-- ---------- leads ----------

create table if not exists public.leads (
  id uuid primary key,
  captured_at timestamptz not null,
  updated_at timestamptz not null,
  first_name text not null default '',
  last_name text not null default '',
  company text not null default '',
  title text not null default '',
  email text not null default '',
  phone text not null default '',
  tags text[] not null default '{}',
  notes text not null default '',
  event text not null default '',
  captured_by text not null default '',
  source text not null default '',
  other_phone text not null default '',
  website text not null default '',
  linkedin text not null default '',
  address text not null default '',
  other_info text not null default '',
  card_photo text not null default '',
  qr_data text not null default '',
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  synced_at timestamptz not null default now()
);

create index if not exists leads_captured_at on public.leads (captured_at);

alter table public.leads enable row level security;

drop policy if exists "Team reads leads" on public.leads;
create policy "Team reads leads" on public.leads
  for select to authenticated using ((select public.is_team_member()));

drop policy if exists "Team adds leads" on public.leads;
create policy "Team adds leads" on public.leads
  for insert to authenticated with check ((select public.is_team_member()));

drop policy if exists "Team edits leads" on public.leads;
create policy "Team edits leads" on public.leads
  for update to authenticated
  using ((select public.is_team_member()))
  with check ((select public.is_team_member()));

drop policy if exists "Team removes leads" on public.leads;
create policy "Team removes leads" on public.leads
  for delete to authenticated using ((select public.is_team_member()));

revoke all on public.leads from anon, authenticated;
grant select, insert, update, delete on public.leads to authenticated;

-- ---------- card photos ----------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('card-photos', 'card-photos', false, 5242880, array['image/jpeg'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Team reads card photos" on storage.objects;
create policy "Team reads card photos" on storage.objects
  for select to authenticated
  using (bucket_id = 'card-photos' and (select public.is_team_member()));

drop policy if exists "Team adds card photos" on storage.objects;
create policy "Team adds card photos" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'card-photos' and (select public.is_team_member()));

drop policy if exists "Team replaces card photos" on storage.objects;
create policy "Team replaces card photos" on storage.objects
  for update to authenticated
  using (bucket_id = 'card-photos' and (select public.is_team_member()))
  with check (bucket_id = 'card-photos' and (select public.is_team_member()));

drop policy if exists "Team removes card photos" on storage.objects;
create policy "Team removes card photos" on storage.objects
  for delete to authenticated
  using (bucket_id = 'card-photos' and (select public.is_team_member()));
