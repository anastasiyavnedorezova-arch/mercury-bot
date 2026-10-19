-- Подключение Telegram к аккаунту с сайта: одноразовые ссылки на бота.
-- В базе хранится только sha256 токена; ссылка живёт 15 минут и срабатывает один раз.
-- Безопасно запускать повторно. Применять вручную к finnik_stage и finnik.

BEGIN;

CREATE TABLE IF NOT EXISTS public.telegram_link_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS telegram_link_tokens_user_idx ON public.telegram_link_tokens (user_id);

ALTER TABLE public.telegram_link_tokens ENABLE ROW LEVEL SECURITY;

-- Приложение работает от роли-владельца остальных таблиц (см. 003): передаём ей и новую таблицу
DO $$
DECLARE owner_name text;
BEGIN
  SELECT tableowner INTO owner_name FROM pg_tables WHERE schemaname = 'public' AND tablename = 'users';
  IF owner_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.telegram_link_tokens OWNER TO %I', owner_name);
  END IF;
END $$;

COMMIT;
