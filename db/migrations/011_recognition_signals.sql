-- Сигналы «научи бота»: фраза, которую бот не распознал, человек записал вручную и согласился передать её разработчику.
-- answer: asked (вопрос задан), sent (человек согласился, сигнал ушёл администратору), declined (отказался).
-- status нужен позже для бонуса за обучение: new (ещё не разобран), accepted (взят в работу), rejected (не подошёл).
-- Безопасно запускать повторно. Применять вручную к finnik_stage и finnik.

BEGIN;

CREATE TABLE IF NOT EXISTS public.recognition_signals (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    phrase text NOT NULL,
    phrase_norm text NOT NULL,
    ai_reason text,
    type text,
    category text,
    amount numeric,
    answer text DEFAULT 'asked' NOT NULL CHECK (answer IN ('asked', 'sent', 'declined')),
    status text DEFAULT 'new' NOT NULL CHECK (status IN ('new', 'accepted', 'rejected')),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    answered_at timestamp with time zone
);

CREATE INDEX IF NOT EXISTS recognition_signals_phrase_idx ON public.recognition_signals (phrase_norm);
CREATE INDEX IF NOT EXISTS recognition_signals_user_idx ON public.recognition_signals (user_id, created_at DESC);

ALTER TABLE public.recognition_signals ENABLE ROW LEVEL SECURITY;

-- Приложение работает от роли-владельца остальных таблиц (см. 003): передаём ей и новую таблицу
DO $$
DECLARE owner_name text;
BEGIN
  SELECT tableowner INTO owner_name FROM pg_tables WHERE schemaname = 'public' AND tablename = 'users';
  IF owner_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.recognition_signals OWNER TO %I', owner_name);
  END IF;
END $$;

COMMIT;
