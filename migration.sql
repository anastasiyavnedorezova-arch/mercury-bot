-- ============================================================
-- Mercury Bot — Database Migration
-- PostgreSQL / Supabase
-- ============================================================

BEGIN;

-- ============================================================
-- 1. USERS
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id    TEXT        NOT NULL,                         -- ID пользователя в канале (telegram_id и т.д.)
  channel        TEXT        NOT NULL DEFAULT 'telegram',      -- 'telegram' | 'vk' | 'web'
  username       TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  last_active_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(external_id, channel)
);

COMMENT ON TABLE  users              IS 'Пользователи бота (Telegram, VK, Web)';
COMMENT ON COLUMN users.external_id  IS 'ID пользователя во внешнем канале (telegram_id и т.д.)';
COMMENT ON COLUMN users.channel      IS 'Канал: telegram | vk | web';

ALTER TABLE users ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 2. SUBSCRIPTIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS subscriptions (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status         TEXT        NOT NULL,                         -- 'free' | 'trial' | 'active' | 'expired'
  period_months  INT,                                         -- NULL для free/trial, 1/6/12 для active
  starts_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ends_at        TIMESTAMPTZ,                                  -- NULL для free, дата для trial/active
  payment_id     TEXT,                                         -- ID платежа от ЮMoney
  amount_rub     INT,                                          -- сумма в рублях
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE  subscriptions              IS 'Подписки пользователей';
COMMENT ON COLUMN subscriptions.status       IS 'Статус: free | trial | active | expired';
COMMENT ON COLUMN subscriptions.period_months IS 'Длительность в месяцах: NULL для free/trial, 1/6/12 для active';
COMMENT ON COLUMN subscriptions.payment_id   IS 'ID платежа от ЮMoney, NULL для free/trial';

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 3. CATEGORY_GROUPS
-- ============================================================
CREATE TABLE IF NOT EXISTS category_groups (
  id         UUID  PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT  NOT NULL,                                   -- 'Еда', 'Транспорт' и т.д.
  type       TEXT  NOT NULL,                                   -- 'income' | 'expense'
  sort_order INT   NOT NULL DEFAULT 0
);

COMMENT ON TABLE  category_groups      IS 'Группы категорий доходов и расходов';
COMMENT ON COLUMN category_groups.type IS 'Тип: income | expense';

ALTER TABLE category_groups ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 4. CATEGORIES
-- ============================================================
CREATE TABLE IF NOT EXISTS categories (
  id         UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id   UUID    NOT NULL REFERENCES category_groups(id),
  user_id    UUID    REFERENCES users(id) ON DELETE CASCADE,   -- NULL = системная, NOT NULL = пользовательская
  name       TEXT    NOT NULL,
  type       TEXT    NOT NULL,                                  -- 'income' | 'expense'
  is_system  BOOL    NOT NULL DEFAULT FALSE,                   -- TRUE = нельзя удалить
  synonyms   TEXT[]  DEFAULT '{}',                             -- для LLM-парсинга
  sort_order INT     NOT NULL DEFAULT 0,
  is_active  BOOL    NOT NULL DEFAULT TRUE
);

COMMENT ON TABLE  categories           IS 'Категории транзакций (системные и пользовательские)';
COMMENT ON COLUMN categories.user_id   IS 'NULL = системная категория, NOT NULL = пользовательская';
COMMENT ON COLUMN categories.is_system IS 'TRUE = защищённая системная категория (нельзя удалить)';
COMMENT ON COLUMN categories.synonyms  IS 'Синонимы для LLM-парсинга сообщений';

ALTER TABLE categories ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 5. GOALS
-- ============================================================
CREATE TABLE IF NOT EXISTS goals (
  id                   UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                 TEXT          NOT NULL,
  target_amount        NUMERIC(12,2) NOT NULL,                 -- сегодняшняя стоимость (PV)
  future_value         NUMERIC(12,2) NOT NULL,                 -- с учётом инфляции (FV)
  initial_saved        NUMERIC(12,2) NOT NULL DEFAULT 0,       -- накоплено на старте
  monthly_payment      NUMERIC(12,2) NOT NULL,                 -- рассчитанный ежемесячный взнос
  target_date          DATE          NOT NULL,
  inflation_rate       NUMERIC(5,4)  NOT NULL DEFAULT 0.06,
  yield_rate           NUMERIC(5,4),                           -- NULL = без доходности (бесплатный тариф)
  status               TEXT          NOT NULL DEFAULT 'active',-- 'active' | 'archived' | 'completed'
  last_recalculated_at TIMESTAMPTZ   DEFAULT NOW(),
  created_at           TIMESTAMPTZ   DEFAULT NOW()
);

COMMENT ON TABLE  goals                   IS 'Финансовые цели пользователей';
COMMENT ON COLUMN goals.target_amount     IS 'Сегодняшняя стоимость цели (PV)';
COMMENT ON COLUMN goals.future_value      IS 'Будущая стоимость с учётом инфляции (FV)';
COMMENT ON COLUMN goals.monthly_payment   IS 'Рассчитанный ежемесячный взнос';
COMMENT ON COLUMN goals.yield_rate        IS 'Доходность вложений; NULL = без доходности (бесплатный тариф)';

ALTER TABLE goals ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 6. TRANSACTIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS transactions (
  id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id      UUID          NOT NULL REFERENCES categories(id),
  goal_id          UUID          REFERENCES goals(id),          -- только для type='goal', иначе NULL
  type             TEXT          NOT NULL,                      -- 'income' | 'expense' | 'goal'
  amount           NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  comment          TEXT,                                        -- название магазина из сообщения
  transaction_date DATE          NOT NULL,                      -- редактируемая дата операции
  created_at       TIMESTAMPTZ   DEFAULT NOW(),                 -- не редактируется
  raw_message      TEXT                                         -- исходный текст для отладки LLM
);

CREATE INDEX IF NOT EXISTS transactions_user_date_idx ON transactions(user_id, transaction_date);

COMMENT ON TABLE  transactions                  IS 'Транзакции пользователей';
COMMENT ON COLUMN transactions.goal_id          IS 'Ссылка на цель — только для type=goal';
COMMENT ON COLUMN transactions.type             IS 'Тип: income | expense | goal';
COMMENT ON COLUMN transactions.comment          IS 'Название магазина / источника из сообщения';
COMMENT ON COLUMN transactions.transaction_date IS 'Редактируемая дата операции';
COMMENT ON COLUMN transactions.created_at       IS 'Дата записи в БД, не редактируется';
COMMENT ON COLUMN transactions.raw_message      IS 'Исходный текст пользователя для отладки LLM';

ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 7. BUDGET
-- ============================================================
CREATE TABLE IF NOT EXISTS budget (
  id         UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month      DATE          NOT NULL,                            -- всегда первое число месяца (2026-03-01)
  amount     NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ   DEFAULT NOW(),
  UNIQUE(user_id, month)
);

COMMENT ON TABLE  budget       IS 'Бюджет пользователя по месяцам';
COMMENT ON COLUMN budget.month IS 'Первое число месяца, например 2026-03-01';

ALTER TABLE budget ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 8. NOTIFICATIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS notifications (
  id      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type    TEXT        NOT NULL,   -- 'budget_reminder' | 'goal_reminder' | 'activity_reminder' |
                                  -- 'analytics_ready' | 'budget_alert_50' | 'budget_alert_80' |
                                  -- 'budget_alert_forecast' | 'trial_ending' | 'subscription_ending'
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  month   DATE                    -- для месячных алертов, NULL для остальных
);

COMMENT ON TABLE  notifications      IS 'Журнал отправленных уведомлений';
COMMENT ON COLUMN notifications.type IS 'Тип уведомления: budget_reminder, goal_reminder, trial_ending и т.д.';
COMMENT ON COLUMN notifications.month IS 'Месяц алерта (первое число); NULL для не-месячных уведомлений';

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;


-- ============================================================
-- SEED DATA
-- ============================================================

-- ---- category_groups ----------------------------------------

INSERT INTO category_groups (name, type, sort_order) VALUES
  -- Доходы
  ('Доход за работу и выплаты',      'income',  1),
  ('Доходность вложений и кешбек',   'income',  2),
  ('Подарки и возвраты',             'income',  3),
  -- Расходы
  ('Еда',                            'expense', 1),
  ('Жильё и дом',                    'expense', 2),
  ('Транспорт',                      'expense', 3),
  ('Здоровье и красота',             'expense', 4),
  ('Досуг и развлечения',            'expense', 5),
  ('Финансы и обязательства',        'expense', 6),
  ('Другое',                         'expense', 7);

-- ---- categories ---------------------------------------------

INSERT INTO categories (group_id, name, type, is_system, synonyms, sort_order)
SELECT g.id, c.name, c.type, c.is_system, c.synonyms, c.sort_order
FROM (VALUES

  -- Доход за работу и выплаты
  ('Доход за работу и выплаты', 'Зарплата',              'income', TRUE,  ARRAY['оклад','аванс','получка'],                                             1),
  ('Доход за работу и выплаты', 'Фриланс и подработка',  'income', FALSE, ARRAY['проект','заказ','подработал'],                                         2),
  ('Доход за работу и выплаты', 'Продажа и соцвыплаты',  'income', FALSE, ARRAY['авито','пособие','декретные'],                                         3),

  -- Доходность вложений и кешбек
  ('Доходность вложений и кешбек', 'Проценты по вкладу',    'income', FALSE, ARRAY['капитализация','накопительный счет'],                               1),
  ('Доходность вложений и кешбек', 'Инвестиционный доход',  'income', FALSE, ARRAY['дивиденды','купоны','брокер'],                                      2),
  ('Доходность вложений и кешбек', 'Кэшбек и бонусы',       'income', FALSE, ARRAY['кэшбек','баллы','бонусы'],                                          3),

  -- Подарки и возвраты
  ('Подарки и возвраты', 'Подарки мне',        'income', FALSE, ARRAY['подарили','денежный подарок'],                                                   1),
  ('Подарки и возвраты', 'Возврат денег',      'income', FALSE, ARRAY['возврат','страховка','налоговый вычет'],                                         2),
  ('Подарки и возвраты', 'Долг мне вернули',   'income', FALSE, ARRAY['вернули долг','отдали деньги'],                                                  3),

  -- Еда
  ('Еда', 'Продукты',       'expense', FALSE, ARRAY['магазин','пятерочка','лента','вкусвилл','азбука вкуса','перекресток','ашан'], 1),
  ('Еда', 'Кафе, рестораны','expense', FALSE, ARRAY['обед','ужин','суши','пицца','бар'],                                           2),
  ('Еда', 'Кофе на вынос',  'expense', FALSE, ARRAY['кофейня','латте','капучино'],                                                  3),
  ('Еда', 'Доставка еды',   'expense', FALSE, ARRAY['яндекс еда','самокат','delivery'],                                             4),

  -- Жильё и дом
  ('Жильё и дом', 'Жильё',           'expense', TRUE,  ARRAY['аренда','ипотека','жку','коммуналка','квартплата'],  1),
  ('Жильё и дом', 'Дом и быт',       'expense', FALSE, ARRAY['хозтовары','бытовая химия','химчистка'],             2),
  ('Жильё и дом', 'Техника и мебель','expense', FALSE, ARRAY['ноутбук','телефон','холодильник'],                   3),

  -- Транспорт
  ('Транспорт', 'Транспорт', 'expense', FALSE, ARRAY['метро','такси','яндекс го','каршеринг'], 1),
  ('Транспорт', 'Авто',      'expense', FALSE, ARRAY['бензин','то','страховка авто','мойка'],  2),

  -- Здоровье и красота
  ('Здоровье и красота', 'Здоровье', 'expense', FALSE, ARRAY['аптека','врач','стоматолог','анализы'],                1),
  ('Здоровье и красота', 'Красота',  'expense', FALSE, ARRAY['маникюр','стрижка','косметолог','косметика'],          2),
  ('Здоровье и красота', 'Спорт',    'expense', FALSE, ARRAY['зал','бассейн','тренер','абонемент'],                  3),

  -- Досуг и развлечения
  ('Досуг и развлечения', 'Одежда и обувь',      'expense', FALSE, ARRAY['шоппинг','wildberries','ozon','lamoda'],     1),
  ('Досуг и развлечения', 'Путешествия',         'expense', FALSE, ARRAY['билеты','отель','тур'],                      2),
  ('Досуг и развлечения', 'Отдых и развлечения', 'expense', FALSE, ARRAY['кино','театр','концерт'],                    3),
  ('Досуг и развлечения', 'Обучение',            'expense', FALSE, ARRAY['курс','книги','онлайн-школа'],               4),
  ('Досуг и развлечения', 'Подписки',            'expense', FALSE, ARRAY['яндекс плюс','netflix','spotify'],           5),
  ('Досуг и развлечения', 'Подарки другим',      'expense', FALSE, ARRAY['подарил','сертификат','цветы'],              6),

  -- Финансы и обязательства
  ('Финансы и обязательства', 'Кредиты и займы',    'expense', TRUE,  ARRAY['кредит','рассрочка','займ'],                       1),
  ('Финансы и обязательства', 'Налоги',             'expense', FALSE, ARRAY['ндфл','налог ип'],                                  2),
  ('Финансы и обязательства', 'Комиссии',           'expense', FALSE, ARRAY['банковская комиссия','комиссия за перевод'],        3),
  ('Финансы и обязательства', 'Долг я дал',         'expense', FALSE, ARRAY['дал в долг','одолжил'],                             4),
  ('Финансы и обязательства', 'Благотворительность','expense', FALSE, ARRAY['пожертвование','донат'],                            5),
  ('Финансы и обязательства', 'Связь и интернет',   'expense', FALSE, ARRAY['мтс','билайн','теле2','мегафон'],                  6),
  ('Финансы и обязательства', 'Цель',               'expense', TRUE,  ARRAY['на цель','копилка','накопления'],                  7),

  -- Другое
  ('Другое', 'Дети',    'expense', FALSE, ARRAY['садик','школа','кружки','репетитор'], 1),
  ('Другое', 'Животные','expense', FALSE, ARRAY['корм','ветеринар','зоомагазин'],      2),
  ('Другое', 'Другое',  'expense', FALSE, ARRAY[]::TEXT[],                             3)

) AS c(group_name, name, type, is_system, synonyms, sort_order)
JOIN category_groups g ON g.name = c.group_name;


-- ============================================================
-- VERIFICATION — количество записей в каждой таблице
-- ============================================================
DO $$
DECLARE
  cnt_users         INT;
  cnt_subscriptions INT;
  cnt_groups        INT;
  cnt_categories    INT;
  cnt_transactions  INT;
  cnt_goals         INT;
  cnt_budget        INT;
  cnt_notifications INT;
BEGIN
  SELECT COUNT(*) INTO cnt_users         FROM users;
  SELECT COUNT(*) INTO cnt_subscriptions FROM subscriptions;
  SELECT COUNT(*) INTO cnt_groups        FROM category_groups;
  SELECT COUNT(*) INTO cnt_categories    FROM categories;
  SELECT COUNT(*) INTO cnt_transactions  FROM transactions;
  SELECT COUNT(*) INTO cnt_goals         FROM goals;
  SELECT COUNT(*) INTO cnt_budget        FROM budget;
  SELECT COUNT(*) INTO cnt_notifications FROM notifications;

  RAISE NOTICE '=== Миграция завершена ===';
  RAISE NOTICE 'users:              %', cnt_users;
  RAISE NOTICE 'subscriptions:      %', cnt_subscriptions;
  RAISE NOTICE 'category_groups:    %', cnt_groups;
  RAISE NOTICE 'categories:         %', cnt_categories;
  RAISE NOTICE 'transactions:       %', cnt_transactions;
  RAISE NOTICE 'goals:              %', cnt_goals;
  RAISE NOTICE 'budget:             %', cnt_budget;
  RAISE NOTICE 'notifications:      %', cnt_notifications;
END;
$$;

-- ============================================================
-- RENAME CATEGORIES (2026-05-10)
-- ============================================================

UPDATE categories SET name = 'Кафе и рестораны'
WHERE name = 'Кафе, рестораны' AND user_id IS NULL;

UPDATE categories SET name = 'Товары в дом'
WHERE name = 'Дом и быт' AND user_id IS NULL;

UPDATE categories SET name = 'Красота и уход за собой'
WHERE name = 'Красота' AND user_id IS NULL;

UPDATE categories SET name = 'Налоги и штрафы'
WHERE name = 'Налоги' AND user_id IS NULL;

UPDATE categories SET name = 'Остальное'
WHERE name = 'Другое' AND is_system = false AND user_id IS NULL;

-- Синонимы для переименованных категорий
UPDATE categories SET synonyms = ARRAY['кафе, рестораны','кафе','ресторан','обед','ужин','суши','пицца','бизнес-ланч','бар','столовая','макдак','kfc','subway','шаурма','вок']
WHERE name = 'Кафе и рестораны' AND user_id IS NULL;

UPDATE categories SET synonyms = ARRAY['дом и быт','хозтовары','бытовая химия','постельное','химчистка']
WHERE name = 'Товары в дом' AND user_id IS NULL;

UPDATE categories SET synonyms = ARRAY['красота','маникюр','стрижка','косметолог','косметика','салон','ноготочки']
WHERE name = 'Красота и уход за собой' AND user_id IS NULL;

UPDATE categories SET synonyms = ARRAY['налоги','ндфл','налог ип','имущественный налог','штраф','гибдд']
WHERE name = 'Налоги и штрафы' AND user_id IS NULL;

UPDATE categories SET synonyms = ARRAY['другое']
WHERE name = 'Остальное' AND user_id IS NULL;

COMMIT;
