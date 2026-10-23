-- 010: взносы на цели привязываются к конкретной цели (transactions.goal_id).
-- До этого взнос «на цель 6000» никуда не привязывался, и бот прибавлял его ко ВСЕМ целям сразу.

-- 1) Удаление цели не должно упираться во внешний ключ: взносы остаются в истории, привязка снимается.
ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_goal_id_fkey;
ALTER TABLE public.transactions
    ADD CONSTRAINT transactions_goal_id_fkey FOREIGN KEY (goal_id) REFERENCES public.goals(id) ON DELETE SET NULL;

-- 2) Быстрая сумма взносов по цели.
CREATE INDEX IF NOT EXISTS transactions_goal_id_idx ON public.transactions (goal_id) WHERE goal_id IS NOT NULL;

-- 3) Старые взносы: если у человека ровно одна активная цель — они относились к ней.
--    При двух и более целях однозначно привязать нельзя, такие записи остаются без цели.
UPDATE public.transactions t
SET goal_id = x.goal_id
FROM (
    SELECT user_id, (array_agg(id))[1] AS goal_id
    FROM public.goals
    WHERE status = 'active'
    GROUP BY user_id
    HAVING count(*) = 1
) x
WHERE t.user_id = x.user_id
  AND t.goal_id IS NULL
  AND t.category_id IN (SELECT id FROM public.categories WHERE name = 'Цель' AND user_id IS NULL);
