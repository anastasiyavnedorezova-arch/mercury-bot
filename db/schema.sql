-- Схема базы Финника (выгружена из Supabase 06.10.2026, PostgreSQL 17.6).
-- Без политик RLS, ролей Supabase и схемы auth: доступ к базе только с сервера приложения.

CREATE TABLE public.budget (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    month date NOT NULL,
    amount numeric(12,2) NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT budget_amount_check CHECK ((amount > (0)::numeric))
);

COMMENT ON TABLE public.budget IS 'Бюджет пользователя по месяцам';

COMMENT ON COLUMN public.budget.month IS 'Первое число месяца, например 2026-03-01';

CREATE TABLE public.categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_id uuid NOT NULL,
    user_id uuid,
    name text NOT NULL,
    type text NOT NULL,
    is_system boolean DEFAULT false NOT NULL,
    synonyms text[] DEFAULT '{}'::text[],
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL
);

COMMENT ON TABLE public.categories IS 'Категории транзакций (системные и пользовательские)';

COMMENT ON COLUMN public.categories.user_id IS 'NULL = системная категория, NOT NULL = пользовательская';

COMMENT ON COLUMN public.categories.is_system IS 'TRUE = защищённая системная категория (нельзя удалить)';

COMMENT ON COLUMN public.categories.synonyms IS 'Синонимы для LLM-парсинга сообщений';

CREATE TABLE public.category_groups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    type text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL
);

COMMENT ON TABLE public.category_groups IS 'Группы категорий доходов и расходов';

COMMENT ON COLUMN public.category_groups.type IS 'Тип: income | expense';

CREATE TABLE public.feedback (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    message text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    status text DEFAULT 'new'::text
);

COMMENT ON TABLE public.feedback IS 'Сообщения обратной связи от пользователей';

COMMENT ON COLUMN public.feedback.status IS 'new | read | replied';

CREATE TABLE public.goals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    target_amount numeric(12,2) NOT NULL,
    future_value numeric(12,2) NOT NULL,
    initial_saved numeric(12,2) DEFAULT 0 NOT NULL,
    monthly_payment numeric(12,2) NOT NULL,
    target_date date NOT NULL,
    inflation_rate numeric(5,4) DEFAULT 0.06 NOT NULL,
    yield_rate numeric(5,4),
    status text DEFAULT 'active'::text NOT NULL,
    last_recalculated_at timestamp with time zone DEFAULT now(),
    created_at timestamp with time zone DEFAULT now()
);

COMMENT ON TABLE public.goals IS 'Финансовые цели пользователей';

COMMENT ON COLUMN public.goals.target_amount IS 'Сегодняшняя стоимость цели (PV)';

COMMENT ON COLUMN public.goals.future_value IS 'Будущая стоимость с учётом инфляции (FV)';

COMMENT ON COLUMN public.goals.monthly_payment IS 'Рассчитанный ежемесячный взнос';

COMMENT ON COLUMN public.goals.yield_rate IS 'Доходность вложений; NULL = без доходности (бесплатный тариф)';

CREATE TABLE public.notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    type text NOT NULL,
    sent_at timestamp with time zone DEFAULT now(),
    month date
);

COMMENT ON TABLE public.notifications IS 'Журнал отправленных уведомлений';

COMMENT ON COLUMN public.notifications.type IS 'Тип уведомления: budget_reminder, goal_reminder, trial_ending и т.д.';

COMMENT ON COLUMN public.notifications.month IS 'Месяц алерта (первое число); NULL для не-месячных уведомлений';

CREATE TABLE public.subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    status text NOT NULL,
    period_months integer,
    starts_at timestamp with time zone DEFAULT now() NOT NULL,
    ends_at timestamp with time zone,
    payment_id text,
    amount_rub integer,
    created_at timestamp with time zone DEFAULT now()
);

COMMENT ON TABLE public.subscriptions IS 'Подписки пользователей';

COMMENT ON COLUMN public.subscriptions.status IS 'Статус: free | trial | active | expired';

COMMENT ON COLUMN public.subscriptions.period_months IS 'Длительность в месяцах: NULL для free/trial, 1/6/12 для active';

COMMENT ON COLUMN public.subscriptions.payment_id IS 'ID платежа от ЮMoney, NULL для free/trial';

CREATE TABLE public.transactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    category_id uuid NOT NULL,
    goal_id uuid,
    type text NOT NULL,
    amount numeric(12,2) NOT NULL,
    comment text,
    transaction_date date NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    raw_message text,
    CONSTRAINT transactions_amount_check CHECK ((amount > (0)::numeric))
);

COMMENT ON TABLE public.transactions IS 'Транзакции пользователей';

COMMENT ON COLUMN public.transactions.goal_id IS 'Ссылка на цель — только для type=goal';

COMMENT ON COLUMN public.transactions.type IS 'Тип: income | expense | goal';

COMMENT ON COLUMN public.transactions.comment IS 'Название магазина / источника из сообщения';

COMMENT ON COLUMN public.transactions.transaction_date IS 'Редактируемая дата операции';

COMMENT ON COLUMN public.transactions.created_at IS 'Дата записи в БД, не редактируется';

COMMENT ON COLUMN public.transactions.raw_message IS 'Исходный текст пользователя для отладки LLM';

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    external_id text NOT NULL,
    channel text DEFAULT 'telegram'::text NOT NULL,
    tg_username text,
    created_at timestamp with time zone DEFAULT now(),
    last_active_at timestamp with time zone DEFAULT now(),
    terms_accepted_at timestamp with time zone,
    terms_version text DEFAULT '1.0'::text,
    email text,
    email_letters_accepted boolean DEFAULT false,
    web_username text,
    status text DEFAULT 'active'::text,
    deleted_at timestamp with time zone,
    merged_into uuid
);

COMMENT ON TABLE public.users IS 'Пользователи бота (Telegram, VK, Web)';

COMMENT ON COLUMN public.users.external_id IS 'ID пользователя во внешнем канале (telegram_id и т.д.)';

COMMENT ON COLUMN public.users.channel IS 'Канал: telegram | vk | web';

ALTER TABLE ONLY public.budget
    ADD CONSTRAINT budget_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.budget
    ADD CONSTRAINT budget_user_id_month_key UNIQUE (user_id, month);

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.category_groups
    ADD CONSTRAINT category_groups_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.feedback
    ADD CONSTRAINT feedback_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.goals
    ADD CONSTRAINT goals_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_external_id_channel_key UNIQUE (external_id, channel);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

CREATE INDEX transactions_user_date_idx ON public.transactions USING btree (user_id, transaction_date);

ALTER TABLE ONLY public.budget
    ADD CONSTRAINT budget_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.category_groups(id);

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.feedback
    ADD CONSTRAINT feedback_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.goals
    ADD CONSTRAINT goals_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.subscriptions
    ADD CONSTRAINT subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id);

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_goal_id_fkey FOREIGN KEY (goal_id) REFERENCES public.goals(id);

ALTER TABLE ONLY public.transactions
    ADD CONSTRAINT transactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_merged_into_fkey FOREIGN KEY (merged_into) REFERENCES public.users(id);
