-- 001b_supabase_import_passwords.sql
-- Copies bcrypt password hashes from auth.users (Supabase) into public.users.
-- Run ONCE on the Supabase project before switching to own-auth login.
-- Safe: only updates rows where password_hash IS NULL, so re-running is harmless.

UPDATE users u
SET
  password_hash       = au.encrypted_password,
  password_changed_at = au.updated_at
FROM auth.users au
WHERE lower(au.email) = lower(u.email)
  AND au.encrypted_password IS NOT NULL
  AND au.encrypted_password <> ''
  AND u.password_hash IS NULL;
