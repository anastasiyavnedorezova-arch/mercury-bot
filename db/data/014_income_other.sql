-- Патч 59б (30.10.2026): системная категория доходов «Другие доходы».
-- Раньше непонятное пополнение уходило в расходную «Остальное»: доход с расходной категорией.
-- Это данные, а не схема, поэтому файл лежит в db/data/, а не в db/migrations/ (тестовая база должна оставаться пустой).
-- Безопасно запускать повторно. Применять вручную к finnik_stage и finnik ДО выкладки кода (код без категории тоже работает: запись уйдёт в «Остальное»).
-- Делает три вещи: группа «Другое» для доходов, категория «Другие доходы», перенос уже записанных доходов из «Остальное» в «Другие доходы».
BEGIN;

INSERT INTO public.category_groups (name, type, sort_order)
SELECT 'Другое', 'income', COALESCE((SELECT max(sort_order) FROM public.category_groups WHERE type = 'income'), 0) + 1
WHERE NOT EXISTS (SELECT 1 FROM public.category_groups WHERE type = 'income' AND name = 'Другое');

INSERT INTO public.categories (group_id, user_id, name, type, is_system, sort_order, is_active)
SELECT g.id, NULL, 'Другие доходы', 'income', true, 1, true
FROM public.category_groups g
WHERE g.type = 'income' AND g.name = 'Другое'
  AND NOT EXISTS (SELECT 1 FROM public.categories c WHERE c.user_id IS NULL AND c.name = 'Другие доходы');

UPDATE public.transactions t
SET category_id = (SELECT id FROM public.categories WHERE user_id IS NULL AND name = 'Другие доходы' LIMIT 1)
WHERE t.type = 'income'
  AND t.category_id IN (SELECT id FROM public.categories WHERE user_id IS NULL AND name = 'Остальное')
  AND EXISTS (SELECT 1 FROM public.categories WHERE user_id IS NULL AND name = 'Другие доходы');

COMMIT;
