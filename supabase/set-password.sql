-- Sets a new password for a login, for when someone has forgotten theirs.
-- Supabase's built-in email only reaches members of your Supabase
-- organization, so for anyone else set the password here: put their email
-- and the new password below (between the two $pw$ marks; any characters
-- are fine), run this in the SQL Editor, then give them the
-- password in person or by phone (never by email or chat). Afterwards delete
-- this query from the SQL Editor's list so the password is not kept there.
-- They stay signed in on any phone that is already signed in.

update auth.users
set encrypted_password = extensions.crypt($pw$NEW PASSWORD HERE$pw$, extensions.gen_salt('bf')),
    updated_at = now()
where lower(email) = lower('person@example.com')
returning email as password_changed;
