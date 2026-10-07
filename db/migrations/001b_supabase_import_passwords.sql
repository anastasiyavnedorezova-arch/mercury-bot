-- ТОЛЬКО для Supabase (SQL Editor). Переносит существующие пароли из Supabase Auth:
-- хеши bcrypt совместимы, пользователи входят прежними паролями.
-- Запускать после 001_own_auth.sql. Безопасно запускать повторно.
-- Если у пользователя в профиле не заполнен e-mail, берём e-mail, с которым он входил (иначе войти не сможет).
UPDATE public.users u
SET password_hash = a.encrypted_password,
    password_changed_at = COALESCE(u.password_changed_at, a.updated_at),
    email = COALESCE(NULLIF(btrim(u.email), ''), lower(btrim(a.email)))
FROM auth.users a
WHERE a.id = u.id
  AND u.password_hash IS NULL
  AND a.encrypted_password IS NOT NULL
  AND a.encrypted_password <> '';
