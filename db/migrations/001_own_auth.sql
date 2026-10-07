-- Собственная авторизация (вместо Supabase Auth).
-- Безопасно запускать повторно. Работает и в Supabase (SQL Editor), и в обычном PostgreSQL.

BEGIN;

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS password_changed_at timestamp with time zone;

COMMENT ON COLUMN public.users.password_hash IS 'bcrypt-хеш пароля для входа на сайте; NULL у пользователей только из Telegram';

-- e-mail всегда храним в нижнем регистре
UPDATE public.users SET email = lower(btrim(email)) WHERE email IS NOT NULL AND email <> lower(btrim(email));

-- Одноразовые ссылки для сброса пароля (в базе только sha256 токена)
CREATE TABLE IF NOT EXISTS public.password_resets (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS password_resets_user_idx ON public.password_resets (user_id);

ALTER TABLE public.password_resets ENABLE ROW LEVEL SECURITY;

-- Среди аккаунтов с входом по паролю e-mail уникален без учёта регистра
CREATE UNIQUE INDEX IF NOT EXISTS users_web_email_key
    ON public.users (lower(email))
    WHERE password_hash IS NOT NULL AND COALESCE(status, 'active') NOT IN ('deleted', 'merged');

COMMIT;
