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
-- Follow-up from the lead board, then the app saving the contact again:
-- the app's upsert names only its own columns, so the follow-up stays.
update public.leads set potential = 'High', follow_up_status = '{"Initial Email Sent","Call Booked"}',
  follow_up_by = '00000000-0000-0000-0000-00000000000a'
where id = '11111111-1111-1111-1111-111111111111';
insert into public.leads (id, captured_at, updated_at, first_name, notes)
values ('11111111-1111-1111-1111-111111111111', now(), now(), 'Jordan', 'edited')
on conflict (id) do update set first_name = excluded.first_name, notes = excluded.notes, updated_at = excluded.updated_at;
do $$ begin
  if (select potential from public.leads) <> 'High' then raise exception 'follow-up potential lost'; end if;
  if (select follow_up_status from public.leads) <> '{"Initial Email Sent","Call Booked"}' then raise exception 'follow-up status lost'; end if;
  if (select follow_up_by from public.leads) <> '00000000-0000-0000-0000-00000000000a' then raise exception 'follow-up person lost'; end if;
  -- add-team-member.sql ran twice: the second name wins.
  if (select array_agg(name) from public.team_list()) <> '{"Member One"}' then raise exception 'team_list should be the named member'; end if;
end $$;
-- Follow-up notes: the database stamps the author and time, whatever is sent.
insert into public.lead_notes (lead_id, body, author, author_name, created_at)
values ('11111111-1111-1111-1111-111111111111', 'Left a voicemail', '00000000-0000-0000-0000-00000000000b', 'Someone else', '2001-01-01');
do $$ begin
  if (select author from public.lead_notes) <> '00000000-0000-0000-0000-00000000000a' then raise exception 'note author not stamped'; end if;
  if (select author_name from public.lead_notes) <> 'Member One' then raise exception 'note author name not stamped'; end if;
  if (select created_at from public.lead_notes) < now() - interval '1 minute' then raise exception 'note time not stamped'; end if;
end $$;
do $$ begin
  insert into public.lead_notes (lead_id, body) values ('11111111-1111-1111-1111-111111111111', '   ');
  raise exception 'a blank note was accepted';
exception when check_violation then null;
end $$;
select pg_temp.expect_denied($$update public.lead_notes set body = 'rewritten'$$);
insert into storage.objects (bucket_id, name) values ('card-photos', '11111111-1111-1111-1111-111111111111.jpg');
select pg_temp.expect_denied($$insert into storage.objects (bucket_id, name) values ('some-other-bucket', 'x.jpg')$$);

-- Someone with a login who is not on the team.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
do $$ begin
  if public.is_team_member() then raise exception 'outsider is on the team'; end if;
  if (select count(*) from public.leads) <> 0 then raise exception 'outsider can see leads'; end if;
  if (select count(*) from storage.objects) <> 0 then raise exception 'outsider can see card photos'; end if;
  if (select count(*) from public.team_members) <> 0 then raise exception 'outsider can see the team'; end if;
  if (select count(*) from public.team_list()) <> 0 then raise exception 'outsider can list the team'; end if;
  if (select count(*) from public.lead_notes) <> 0 then raise exception 'outsider can read notes'; end if;
end $$;
select pg_temp.expect_denied($$insert into public.lead_notes (lead_id, body) values ('11111111-1111-1111-1111-111111111111', 'spam')$$);
delete from public.lead_notes;
select pg_temp.expect_denied($$insert into public.leads (id, captured_at, updated_at) values (gen_random_uuid(), now(), now())$$);
select pg_temp.expect_denied($$insert into storage.objects (bucket_id, name) values ('card-photos', 'y.jpg')$$);
update public.leads set notes = 'hacked', potential = 'Low';
delete from public.leads;

-- The publishable key alone (anon).
reset role;
set role anon;
select set_config('request.jwt.claim.sub', '', false);
select pg_temp.expect_denied($$select count(*) from public.leads$$);
select pg_temp.expect_denied($$select public.is_team_member()$$);
select pg_temp.expect_denied($$select * from public.team_list()$$);
select pg_temp.expect_denied($$select count(*) from public.lead_notes$$);
select pg_temp.expect_denied($$insert into public.team_members (user_id, email) values ('00000000-0000-0000-0000-00000000000b', 'x')$$);
do $$ begin
  if (select count(*) from storage.objects) <> 0 then raise exception 'anon can see card photos'; end if;
end $$;

-- The member's lead survived the outsider's update and delete.
reset role;
do $$ begin
  if (select notes from public.leads) <> 'edited' then raise exception 'outsider changed a lead'; end if;
  if (select potential from public.leads) <> 'High' then raise exception 'outsider changed the follow-up'; end if;
  if (select count(*) from public.lead_notes) <> 1 then raise exception 'outsider removed a note'; end if;
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

-- A teammate cannot delete someone else's note; the author can, and
-- deleting the lead takes its notes with it.
insert into public.team_members (user_id, email, name) values ('00000000-0000-0000-0000-00000000000b', 'outsider@example.com', 'Teammate');
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
delete from public.lead_notes;
insert into public.lead_notes (lead_id, body) values ('11111111-1111-1111-1111-111111111111', 'Sent the brochure');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
do $$ begin
  if (select count(*) from public.lead_notes) <> 2 then raise exception 'a teammate removed someone else''s note'; end if;
  if (select array_agg(author_name order by author_name) from public.lead_notes) <> '{"Member One",Teammate}' then raise exception 'note authors wrong'; end if;
end $$;
delete from public.lead_notes where author_name = 'Member One';
do $$ begin
  if (select count(*) from public.lead_notes) <> 1 then raise exception 'author could not remove their own note'; end if;
end $$;
delete from public.leads;
do $$ begin
  if (select count(*) from public.lead_notes) <> 0 then raise exception 'notes outlived their lead'; end if;
end $$;
reset role;
delete from public.team_members where user_id = '00000000-0000-0000-0000-00000000000b';

-- set-password.sql (run by run.sh) changed the member's password, and only theirs.
do $$ begin
  if (select encrypted_password = extensions.crypt('it''s a new one', encrypted_password) from auth.users where email = 'Member@Example.com') is not true then
    raise exception 'set-password.sql did not set the password';
  end if;
  if (select encrypted_password from auth.users where email = 'outsider@example.com') is not null then raise exception 'set-password.sql changed another login'; end if;
end $$;

\o
\echo 'all database checks passed'
