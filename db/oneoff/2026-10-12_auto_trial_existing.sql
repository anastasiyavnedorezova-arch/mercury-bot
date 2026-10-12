-- Разовая выдача пробного периода (30 дней) существующим пользователям, у которых ещё нет НИКАКИХ записей подписки.
-- Не трогает тех, у кого уже есть запись (в том числе триал, выданный вручную до 31.12.2026, закончившийся триал и платные подписки).
-- Применять вручную к боевой базе `finnik` и к `finnik_stage`. Безопасно запускать повторно: второй запуск ничего не добавит.
--
-- Сначала посмотреть, кому будет выдан триал (ничего не меняет):
--   SELECT id, email, channel, created_at FROM public.users u
--    WHERE u.terms_accepted_at IS NOT NULL
--      AND NOT EXISTS (SELECT 1 FROM public.subscriptions s WHERE s.user_id = u.id);

BEGIN;

INSERT INTO public.subscriptions (user_id, status, starts_at, ends_at, period_months, payment_id, amount_rub)
SELECT u.id, 'trial', now(), now() + interval '30 days', NULL, NULL, NULL
  FROM public.users u
 WHERE u.terms_accepted_at IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.subscriptions s WHERE s.user_id = u.id);

COMMIT;
