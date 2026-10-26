-- Lets a person use InfoCapture. First create their login in the Supabase
-- dashboard (Authentication > Users > Add user > Create new user, with
-- "Auto Confirm User" ticked), then put their email below and run this in
-- the SQL Editor. Run it once per person.

insert into public.team_members (user_id, email)
select id, email from auth.users where lower(email) = lower('person@example.com')
on conflict (user_id) do nothing
returning email as added;

-- To remove someone: delete from public.team_members where email = 'person@example.com';
-- To see the team:   select email, added_at from public.team_members order by added_at;
