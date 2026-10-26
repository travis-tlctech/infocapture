-- Runs after stubs.sql and setup.sql (twice). Fails loudly on the first
-- broken expectation. The users come from stubs.sql; run.sh adds the member
-- (...0a) to the team with add-team-member.sql.
\set ON_ERROR_STOP on
\o /dev/null

create function pg_temp.expect_denied(sql text) returns void language plpgsql as $$
begin
  execute sql;
  raise exception 'expected this to be refused: %', sql;
exception
  when insufficient_privilege then null;
  when others then
    if sqlerrm like 'new row violates row-level security%' then null; else raise; end if;
end $$;

-- The member, signed in.
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
do $$ begin
  if not public.is_team_member() then raise exception 'member is not on the team'; end if;
end $$;
insert into public.leads (id, captured_at, updated_at, first_name, tags)
values ('11111111-1111-1111-1111-111111111111', now(), now(), 'Jordan', '{"Hot lead"}');
-- The app's upsert: insert, and on a retry update in place.
insert into public.leads (id, captured_at, updated_at, first_name, notes)
values ('11111111-1111-1111-1111-111111111111', now(), now(), 'Jordan', 'edited')
on conflict (id) do update set notes = excluded.notes, updated_at = excluded.updated_at;
do $$ begin
  if (select count(*) from public.leads) <> 1 then raise exception 'member should see 1 lead'; end if;
  if (select notes from public.leads) <> 'edited' then raise exception 'upsert did not update'; end if;
  if (select created_by from public.leads) <> '00000000-0000-0000-0000-00000000000a' then raise exception 'created_by not set'; end if;
end $$;
insert into storage.objects (bucket_id, name) values ('card-photos', '11111111-1111-1111-1111-111111111111.jpg');
select pg_temp.expect_denied($$insert into storage.objects (bucket_id, name) values ('some-other-bucket', 'x.jpg')$$);

-- Someone with a login who is not on the team.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
do $$ begin
  if public.is_team_member() then raise exception 'outsider is on the team'; end if;
  if (select count(*) from public.leads) <> 0 then raise exception 'outsider can see leads'; end if;
  if (select count(*) from storage.objects) <> 0 then raise exception 'outsider can see card photos'; end if;
  if (select count(*) from public.team_members) <> 0 then raise exception 'outsider can see the team'; end if;
end $$;
select pg_temp.expect_denied($$insert into public.leads (id, captured_at, updated_at) values (gen_random_uuid(), now(), now())$$);
select pg_temp.expect_denied($$insert into storage.objects (bucket_id, name) values ('card-photos', 'y.jpg')$$);
update public.leads set notes = 'hacked';
delete from public.leads;

-- The publishable key alone (anon).
reset role;
set role anon;
select set_config('request.jwt.claim.sub', '', false);
select pg_temp.expect_denied($$select count(*) from public.leads$$);
select pg_temp.expect_denied($$select public.is_team_member()$$);
select pg_temp.expect_denied($$insert into public.team_members (user_id, email) values ('00000000-0000-0000-0000-00000000000b', 'x')$$);
do $$ begin
  if (select count(*) from storage.objects) <> 0 then raise exception 'anon can see card photos'; end if;
end $$;

-- The member's lead survived the outsider's update and delete.
reset role;
do $$ begin
  if (select notes from public.leads) <> 'edited' then raise exception 'outsider changed a lead'; end if;
  if (select public from storage.buckets where id = 'card-photos') then raise exception 'bucket is public'; end if;
end $$;

-- Members can't add themselves or others: team_members has no insert grant.
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
select pg_temp.expect_denied($$insert into public.team_members (user_id, email) values ('00000000-0000-0000-0000-00000000000b', 'x')$$);
do $$ begin
  if (select count(*) from public.team_members) <> 1 then raise exception 'member should see only their own row'; end if;
end $$;
reset role;

\o
\echo 'all database checks passed'
