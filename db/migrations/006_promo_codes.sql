-- Промокоды на скидку в рублях при оплате подписки.
-- promo_codes — сами коды (создаются командой на сервере: node tools/promo.mjs create ...),
-- promo_redemptions — когда и кем код использован (запись появляется только после успешной оплаты).
-- Безопасно запускать повторно. Применять вручную к finnik_stage и finnik.

BEGIN;

CREATE TABLE IF NOT EXISTS public.promo_codes (
    code text NOT NULL PRIMARY KEY,
    amount_off_rub integer NOT NULL CHECK (amount_off_rub > 0),
    max_uses integer CHECK (max_uses IS NULL OR max_uses > 0),
    per_user_limit integer DEFAULT 1 NOT NULL CHECK (per_user_limit > 0),
    expires_at timestamp with time zone,
    active boolean DEFAULT true NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT promo_codes_code_format CHECK (code ~ '^[A-Z0-9_-]{3,32}$')
);

-- Один платёж засчитывается один раз (повторное уведомление ЮKassa ничего не удвоит)
CREATE TABLE IF NOT EXISTS public.promo_redemptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    code text NOT NULL,
    user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    payment_id text NOT NULL,
    amount_off_rub integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT promo_redemptions_payment_key UNIQUE (payment_id)
);

CREATE INDEX IF NOT EXISTS promo_redemptions_code_idx ON public.promo_redemptions (code);
CREATE INDEX IF NOT EXISTS promo_redemptions_user_idx ON public.promo_redemptions (user_id);

ALTER TABLE public.promo_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.promo_redemptions ENABLE ROW LEVEL SECURITY;

-- Приложение работает от роли-владельца остальных таблиц (см. 003): передаём ей и новые таблицы
DO $$
DECLARE owner_name text;
BEGIN
  SELECT tableowner INTO owner_name FROM pg_tables WHERE schemaname = 'public' AND tablename = 'users';
  IF owner_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.promo_codes OWNER TO %I', owner_name);
    EXECUTE format('ALTER TABLE public.promo_redemptions OWNER TO %I', owner_name);
  END IF;
END $$;

COMMIT;
