-- Источник регистрации: метки рекламной ссылки (utm_*), сайт-источник, страница входа.
-- Заполняется при регистрации на сайте и при первом /start в боте по ссылке с сайта. Нужна для подсчёта стоимости привлечения.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS utm jsonb;
COMMENT ON COLUMN public.users.utm IS 'Источник регистрации: {utm_source, utm_medium, utm_campaign, utm_content, utm_term, ref, landing, at, via}';
