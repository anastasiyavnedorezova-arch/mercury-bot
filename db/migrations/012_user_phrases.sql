-- Личная память фраз: человек один раз записал фразу вручную или исправил категорию, и в следующий раз
-- такая же фраза у него записывается в ту же категорию сама. Память у каждого аккаунта своя (user_id), чужие не читаются.
-- Безопасно запускать повторно. Применять вручную к finnik_stage и finnik.

BEGIN;

CREATE TABLE IF NOT EXISTS public.user_phrases (
    user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    phrase_norm text NOT NULL,
    type text NOT NULL CHECK (type IN ('expense', 'income')),
    category text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (user_id, phrase_norm)
);

ALTER TABLE public.user_phrases ENABLE ROW LEVEL SECURITY;

-- Приложение работает от роли-владельца остальных таблиц (см. 003): передаём ей и новую таблицу
DO $$
DECLARE owner_name text;
BEGIN
  SELECT tableowner INTO owner_name FROM pg_tables WHERE schemaname = 'public' AND tablename = 'users';
  IF owner_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.user_phrases OWNER TO %I', owner_name);
  END IF;
END $$;

COMMIT;
