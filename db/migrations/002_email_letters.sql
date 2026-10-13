-- Письма-цепочки: журнал отправок и признаки «отписался» / «почта недоступна».
-- Безопасно запускать повторно. Применять вручную к finnik_stage и finnik.

BEGIN;

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS email_unsubscribed_at timestamp with time zone;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS email_blocked_at timestamp with time zone;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS email_block_reason text;

COMMENT ON COLUMN public.users.email_unsubscribed_at IS 'Когда пользователь отписался от писем о возможностях (ссылка в письме)';
COMMENT ON COLUMN public.users.email_blocked_at IS 'Почте больше не пишем: постоянный отказ доставки или жалоба на спам';
COMMENT ON COLUMN public.users.email_block_reason IS 'hard_bounce | spam_complaint | другое';

-- Одно письмо каждого вида — одному пользователю один раз (unique), повторная отправка невозможна
CREATE TABLE IF NOT EXISTS public.email_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    letter text NOT NULL,
    status text DEFAULT 'sending' NOT NULL,
    provider_uuid text,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    CONSTRAINT email_log_user_letter_key UNIQUE (user_id, letter),
    CONSTRAINT email_log_status_check CHECK (status IN ('sending', 'sent', 'failed'))
);

CREATE INDEX IF NOT EXISTS email_log_provider_idx ON public.email_log (provider_uuid);
CREATE INDEX IF NOT EXISTS email_log_created_idx ON public.email_log (created_at);

ALTER TABLE public.email_log ENABLE ROW LEVEL SECURITY;

COMMIT;
