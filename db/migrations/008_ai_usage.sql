-- Счётчик запросов к ИИ: сколько «весов» потратил каждый человек за московские сутки и всего (строка subject = '*').
-- Нужен для дневного лимита на человека и общего предохранителя расходов OpenAI.
-- Безопасно запускать повторно. Применять вручную к finnik_stage и finnik.

BEGIN;

CREATE TABLE IF NOT EXISTS public.ai_usage (
    subject text NOT NULL,
    day date NOT NULL,
    requests integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (subject, day)
);

ALTER TABLE public.ai_usage ENABLE ROW LEVEL SECURITY;

-- Приложение работает от роли-владельца остальных таблиц (см. 003): передаём ей и новую таблицу
DO $$
DECLARE owner_name text;
BEGIN
  SELECT tableowner INTO owner_name FROM pg_tables WHERE schemaname = 'public' AND tablename = 'users';
  IF owner_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.ai_usage OWNER TO %I', owner_name);
  END IF;
END $$;

COMMIT;
