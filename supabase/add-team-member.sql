-- Lets a person use InfoCapture. First create their login in the Supabase
-- dashboard (Authentication > Users > Add user > Create new user, with
-- "Auto Confirm User" ticked), then put their email and name below and run
-- this in the SQL Editor. Running it again for the same person updates
-- their name (shown on the lead board).

insert into public.team_members (user_id, email, name)
select id, email, 'Their Name' from auth.users where lower(email) = lower('person@example.com')
on conflict (user_id) do update set name = excluded.name
returning email as added, name;

-- To remove someone: delete from public.team_members where email = 'person@example.com';
-- To see the team:   select email, added_at from public.team_members order by added_at;
