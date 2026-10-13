-- Письма: события от RuSender (доставлено, открыто, отказ, жалоба...) и учёт повторных попыток отправки.
-- Безопасно запускать повторно. Применять вручную к finnik_stage и finnik.

BEGIN;

-- Когда последний раз пытались отправить и сколько раз (для повтора письма после сбоя)
ALTER TABLE public.email_log ADD COLUMN IF NOT EXISTS attempted_at timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE public.email_log ADD COLUMN IF NOT EXISTS attempts integer DEFAULT 1 NOT NULL;

-- Все события, которые прислал RuSender, в исходном виде (raw) + то, что мы из них поняли
CREATE TABLE IF NOT EXISTS public.email_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    event text NOT NULL,
    provider_uuid text,
    user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
    letter text,
    raw jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS email_events_received_idx ON public.email_events (received_at);
CREATE INDEX IF NOT EXISTS email_events_user_idx ON public.email_events (user_id);
CREATE INDEX IF NOT EXISTS email_events_provider_idx ON public.email_events (provider_uuid);

ALTER TABLE public.email_events ENABLE ROW LEVEL SECURITY;

-- Приложение работает от роли-владельца остальных таблиц. Если миграцию запускали от postgres, таблицы писем
-- принадлежат ему, и приложение получит «permission denied». Передаём обе таблицы владельцу таблицы users.
DO $$
DECLARE owner_name text;
BEGIN
  SELECT tableowner INTO owner_name FROM pg_tables WHERE schemaname = 'public' AND tablename = 'users';
  IF owner_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.email_log OWNER TO %I', owner_name);
    EXECUTE format('ALTER TABLE public.email_events OWNER TO %I', owner_name);
  END IF;
END $$;

COMMIT;
