-- Один платёж ЮKassa = одна запись подписки. Защита от двойного начисления, если ЮKassa пришлёт уведомление дважды.
-- Безопасно запускать повторно. Применять вручную к finnik_stage и finnik.
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_payment_id_key ON public.subscriptions (payment_id) WHERE payment_id IS NOT NULL;
