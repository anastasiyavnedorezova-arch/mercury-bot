# Меркури — Саммари проекта
*Последнее обновление: июнь 2026*

---

## 1. ПРОДУКТ

**Меркури** — Telegram-бот для ведения личных финансов.
- ЦА: женщины 25–40 лет, Россия
- Канал: Telegram-бот + личный кабинет (PWA, в разработке)
- Оператор: Недорезова Анастасия Вячеславовна (самозанятая)
- Email: mercury.finbot@yandex.com
- Бот: @MercuryFinBot

---

## 2. ТЕХНИЧЕСКИЙ СТЕК

| Компонент | Технология |
|-----------|-----------|
| Runtime | Node.js 22, ES Modules |
| Telegram | node-telegram-bot-api (polling) |
| База данных | Supabase (PostgreSQL), Frankfurt |
| LLM | OpenAI GPT-4o-mini + Whisper |
| Хостинг бота | Railway |
| Планировщик | node-cron |
| Веб-сервер | Express (вебхук ЮKassa + ЛК) |
| Платежи | ЮKassa |

**Репозиторий:** https://github.com/anastasiyavnedorezova-arch/mercury-bot

**Railway URL:** https://web-production-b5497.up.railway.app

---

## 3. БАЗА ДАННЫХ (Supabase)

**Project URL:** https://ijvkcskzvwluntrsbcsj.supabase.co
**Region:** Frankfurt (EU) → перенести на RU до запуска рекламы

### Таблицы

| Таблица | Назначение |
|---------|-----------|
| users | Пользователи (external_id + channel = уникальная пара) |
| subscriptions | Подписки: free / trial / active / expired |
| category_groups | 10 групп категорий |
| categories | 37 системных + пользовательские категории |
| transactions | Все доходы, расходы, пополнения цели |
| goals | Финансовые цели (active / archived / completed) |
| budget | Месячные бюджеты |
| notifications | Лог отправленных уведомлений |
| feedback | Обратная связь от пользователей |

### Ключевые поля users
```
external_id, channel, username, email,
terms_accepted_at, terms_version,
created_at, last_active_at
```

### Важные особенности схемы БД
- Поле даты транзакций: `transaction_date` (не `date`)
- Поле комментария: `comment` (не `description`)
- Таблица categories: НЕТ полей `emoji`, `icon`, `hint`, `created_at`
- Поле user_id в categories: NULL = системная, не NULL = пользовательская
- ORDER BY в categories: `user_id NULLS FIRST, name ASC` (нет created_at)

### Проверка активной подписки
```sql
SELECT * FROM subscriptions
WHERE user_id = X
AND status IN ('trial', 'active')
AND ends_at > NOW()
ORDER BY ends_at DESC LIMIT 1;
```

### Просмотр пользователей и тарифов
```sql
SELECT u.username, u.external_id,
       s.status, s.ends_at::date,
       EXTRACT(DAY FROM s.ends_at - NOW())::int as days_left
FROM users u
LEFT JOIN subscriptions s ON s.user_id = u.id
  AND s.ends_at > NOW() - INTERVAL '60 days'
ORDER BY u.created_at DESC;
```

### Продление trial
```sql
UPDATE subscriptions
SET ends_at = '2026-06-30 23:59:59'
WHERE status = 'trial' AND ends_at > NOW();
```

### Ручная активация подписки (через бота)
```
/activate <telegram_id> <months>
```

---

## 4. СТРУКТУРА ПРОЕКТА

```
mercury-bot/
├── src/
│   ├── bot.js                 — точка входа
│   ├── db.js                  — Supabase клиент
│   ├── webhook.js             — Express, маршруты ЛК + вебхук ЮKassa
│   ├── cabinetRoutes.js       — все API маршруты /api/*
│   ├── authMiddleware.js      — JWT проверка (requireAuth)
│   ├── handlers/
│   │   ├── start.js           — /start, онбординг шаг 0+1
│   │   ├── onboarding.js      — ветки онбординга, активация trial
│   │   ├── message.js         — обработка текста, вызов LLM
│   │   ├── voice.js           — голосовые (Whisper)
│   │   ├── fileUpload.js      — распознавание выписок (Vision)
│   │   ├── menu.js            — главное меню
│   │   ├── goal.js            — /goal, цели
│   │   ├── budget.js          — /budget, бюджет
│   │   ├── history.js         — /history, история
│   │   ├── analytics.js       — /analytics, аналитика
│   │   ├── categories.js      — /categories, категории
│   │   ├── subscription.js    — /subscription, подписка
│   │   ├── feedback.js        — /feedback
│   │   └── faq.js             — /ask_question, FAQ
│   ├── prompts/
│   │   └── system_prompt.js   — системный промпт LLM-парсера
│   ├── notifications/
│   │   ├── scheduler.js       — node-cron расписание
│   │   └── index.js           — все функции уведомлений
│   └── utils/
│       ├── access.js          — getUserAccess(userId) → free/trial/active
│       ├── goalCalc.js        — calculateMonthlyPayment()
│       └── parseAmount.js     — распознавание сумм с мультипликаторами
├── public/
│   └── cabinet/
│       ├── login.html         — вход (email + Telegram Login Widget)
│       ├── register.html      — регистрация
│       ├── tg-callback.html   — обработка Telegram OAuth редиректа
│       ├── dashboard.html     — дашборд ✅
│       ├── accounting.html    — учёт по месяцам ✅
│       ├── history.html       — история транзакций ✅
│       ├── categories.html    — категории ✅
│       └── how-to.html        — как установить бота ✅
├── .env                       — секреты (не в git)
├── Dockerfile                 — для Railway
├── railway.json
└── package.json
```

---

## 5. ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ (.env и Railway)

```
TELEGRAM_BOT_TOKEN=
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
SUPABASE_ANON_KEY=
OPENAI_API_KEY=
JWT_SECRET=
ADMIN_TELEGRAM_ID=331322698
PAYMENT_LINK_1MONTH=https://yookassa.ru/my/i/adzDDIKW3CfT/l
PAYMENT_LINK_6MONTHS=https://yookassa.ru/my/i/adzFul9bttDk/l
PAYMENT_LINK_12MONTHS=https://yookassa.ru/my/i/adzFf8pposQv/l
NIXPACKS_NODE_VERSION=20
```

---

## 6. ТАРИФЫ

| Тариф | Цена | Цели | Редактирование | Бюджет | Аналитика |
|-------|------|------|----------------|--------|-----------|
| Бесплатно | 0 ₽ | 1 (инфляция) | ✅ | ❌ | Ежемесячная |
| Trial | 0 ₽/30 дней | 3 (с доходностью) | ✅ | ✅ | По запросу |
| Подписка 1 мес | 499 ₽ | 3 (с доходностью) | ✅ | ✅ | По запросу |
| Подписка 6 мес | 2 490 ₽ | 3 (с доходностью) | ✅ | ✅ | По запросу |
| Подписка 12 мес | 4 490 ₽ | 3 (с доходностью) | ✅ | ✅ | По запросу |

---

## 7. КАТЕГОРИИ

### Системные категории (нельзя удалить/редактировать)
- Жильё
- Кредиты и займы
- Цель

### Группы доходов (3)
Доход за работу и выплаты / Доходность вложений и кешбек / Подарки и возвраты

### Группы расходов (7)
Еда / Жильё и дом / Транспорт / Здоровье и красота / Досуг и развлечения / Финансы и обязательства / Другое

---

## 8. ЛИЧНЫЙ КАБИНЕТ (ЛК) — текущий статус

### Маршруты (webhook.js)
- `GET /cabinet` → редирект на `/cabinet/dashboard`
- `GET /cabinet/login` → login.html
- `GET /cabinet/register` → register.html
- `GET /cabinet/dashboard` → dashboard.html
- `GET /cabinet/accounting` → accounting.html
- `GET /cabinet/history` → history.html
- `GET /cabinet/categories` → categories.html
- `GET /cabinet/how-to` → how-to.html
- Все `.html` редиректят на чистые URL (301)

### API (cabinetRoutes.js)
- `POST /api/auth/telegram` — вход через Telegram Login Widget (HMAC-SHA256)
- `GET /api/me` — данные текущего пользователя
- `GET /api/dashboard` — данные дашборда
- `GET /api/accounting` — учёт по месяцам
- `GET /api/history?offset=0` — история (LIMIT 50, пагинация)
- `PUT /api/history/:id` — редактировать транзакцию
- `DELETE /api/history/:id` — удалить транзакцию
- `GET /api/categories` — список категорий (системные + пользовательские)
- `POST /api/categories` — создать пользовательскую категорию
- `PUT /api/categories/:id` — переименовать категорию
- `DELETE /api/categories/:id` — деактивировать категорию (soft delete)
- `GET /api/goals` — список целей
- `GET /api/budget?month=YYYY-MM` — бюджет за месяц
- `GET /api/transactions?limit=&offset=&month=` — транзакции

### JWT
- Хранится в `localStorage.mercury_token`
- Извлечение: `const raw = localStorage.getItem('mercury_token'); const token = raw?.startsWith('{') ? JSON.parse(raw).access_token : raw`
- Срок: 30 дней

### Реализованные страницы ЛК

**dashboard.html** ✅
- Баланс текущего месяца, статус подписки
- Прогресс целей: `initial_saved + SUM(транзакции категории "Цель")` vs `future_value`
- Топ-5 категорий расходов, последние 10 транзакций
- Модалка выхода из аккаунта

**accounting.html** ✅
- Таблица месяц за месяцем от даты регистрации
- Будущие месяцы: opacity 0.2
- Данные: доходы, расходы, баланс по каждому месяцу

**history.html** ✅
- Список транзакций с пагинацией (кнопка "Загрузить ещё")
- Десктоп: кнопки редактировать/удалить в строке
- Мобайл: тап на строку → модалка с деталями
- Модалка редактирования (PUT), модалка удаления (DELETE)
- Фильтры: по типу (расход/доход), по категории, по дате
- Кнопка выгрузки в CSV

**categories.html** ✅
- Таблица: Тип / Группа / Категория / Действия
- Фильтры: ДОХОД / РАСХОД / МОИ КАТЕГОРИИ
- Пользовательские категории: кнопки редактировать + удалить
- Системные категории: кнопки скрыты
- Модалка создания/редактирования: тип, название, эмодзи, подсказки для бота
- Модалка удаления с подтверждением
- Кнопки модалок: десктоп — в ряд (Отменить + Сохранить), мобайл — в колонку
- Паддинги модалки: desktop 32px, mobile 20px

**how-to.html** ✅
- Инструкция установки PWA для iOS (Safari) и Android (Chrome)
- Пошаговые инструкции с нумерацией
- Блок "Что вы получаете после установки"
- Блок контактов с email

### Страницы ЛК — ещё не реализованы
- goals.html — мои цели
- budget.html — мой бюджет
- analytics.html — аналитика
- profile.html — мой профиль
- faq.html — вопросы и ответы
- feedback.html — обратная связь

---

## 9. УВЕДОМЛЕНИЯ (scheduler.js)

Расписание: ежедневно в 10:00 МСК (07:00 UTC)

| Уведомление | Триггер |
|-------------|---------|
| Напоминание о бюджете | 1, 3, 5 числа если нет бюджета |
| Напоминание о цели | Через 15 дней после старта, потом каждые 30 дней |
| Напоминание вносить записи | Нет записей 3 дня, макс 4 раза |
| Аналитика готова | 1-е число месяца |
| Алерт бюджета 50% | С 1 по 10-е, потрачено ≥50% |
| Алерт бюджета 80% | С 1 по 20-е, потрачено ≥80% |
| Алерт прогноза | После 20-го, прогноз ≥100% |
| Окончание trial | За 3 дня и за 1 день |
| Окончание подписки | За 3 дня и за 1 день |

---

## 10. ДЕПЛОЙ

### Обновить бота на Railway
```bash
cd ~/Documents/mercury-bot
git add .
git commit -m "описание изменений"
git push
```
Railway подхватывает автоматически (~2 мин).

### Перезапуск локально (для теста)
```bash
cd ~/Documents/mercury-bot
npm start
```

### Если Railway не деплоит
Railway → сервис → Deployments → три точки → Redeploy

### Если Claude Code требует логин
```bash
claude auth login
```

### Конфликт 409 (два бота запущены)
```bash
pkill -f "node src/bot.js"
```

### VPS Timeweb (пока не используется)
```bash
ssh root@201.51.1.124
pm2 stop all  # если бот запустился на VPS и создаёт 409
```

---

## 11. FIGMA

**Файл:** https://www.figma.com/design/SsajgEYpBnAadRG0MUXfJC/Mercury

### Страницы
- Лендинг (сайт для рекламы) — почти готов
- Дашборд (ЛК) — реализован
- История транзакций (ЛК) — реализована
- Категории (ЛК) — реализована
- Профиль (ЛК) — контент готов, дизайн в работе
- Аналитика (ЛК) — в работе

### Цветовое решение
Основной акцент: `#4C9AFF` (синий), зелёный акцент: `#2FBF71`, фон: `#F5F7FA`

---

## 12. РОАДМАП

### Текущий статус: Бета-тест + разработка ЛК
Бот запущен, идёт сбор фидбека. ЛК в активной разработке.

### Реализовано ✅
- Telegram Login Widget (авторизация в ЛК)
- Dashboard, Accounting, History, Categories, How-to

### В работе
- [ ] goals.html — мои цели
- [ ] budget.html — мой бюджет
- [ ] analytics.html — аналитика
- [ ] profile.html — мой профиль
- [ ] faq.html — вопросы и ответы
- [ ] feedback.html — обратная связь

### Инфраструктура (план миграции на РФ)
- Фаза 0: исследование YandexGPT / GigaChat как замена OpenAI
- Фаза 1: подготовка Timeweb VPS (201.51.1.124, Москва) — оплачен
- Фаза 2: перенос кода
- Фаза 3: переключение DNS
- Фаза 4: отключение Railway/Supabase Frankfurt
- **Причина:** OpenAI возвращает 403 с российских IP

### Post-MVP
- [ ] Семейный бюджет (households, members)
- [ ] Лимиты на неделю
- [ ] Период «от зарплаты до зарплаты»
- [ ] Подключение MAX (требует ИП)
- [ ] Модульность подписки

---

## 13. ИЗВЕСТНЫЕ ОСОБЕННОСТИ И РЕШЕНИЯ

### Архитектура
- Бэкенд канал-независимый: `external_id + channel` в users
- LLM-парсер живёт в API, не в боте
- State хранится в памяти (Map) — сбрасывается через 30 минут

### Логика прогресса целей
`saved = initial_saved + SUM(транзакции где category_id = id категории "Цель")`
Сравнивается с `future_value` (не `target_amount`). Именно так считает бот.

### Подписка в ЛК
Trial-пользователи НЕ должны блокироваться при доступе к бюджету и другим платным функциям — статус `trial` считается активным.

### Shared layout
Попытка вынести хедер/сайдбар в отдельный `layout.js` провалилась и была откачена через `git revert`. Хедер и сайдбар дублируются в каждом HTML-файле.

### Telegram Login Widget
- BotFather: /setdomain → @mercury_finbot → mercuryfinbot.ru
- Скрипт: `data-telegram-login="mercury_finbot"`
- Колбэк: `/cabinet/tg-callback.html` читает параметры из URL → POST /api/auth/telegram

### ЮKassa вебхук
Пользователь идентифицируется по email из `custEmail` в metadata.
Email сохраняется в `users.email` перед переходом на оплату.

### Голосовые сообщения
OpenAI Whisper-1, язык ru. Стоимость ~$0.006/мин.

### Распознавание выписок
GPT-4o Vision. PDF передаётся напрямую в base64.
Три группы: готовы к записи / нужно уточнение / переводы физлицам.

---

## 14. ЮРИДИЧЕСКИЕ ДОКУМЕНТЫ

| Документ | Ссылка |
|----------|--------|
| Политика конфиденциальности | https://telegra.ph/Politika-konfidencialnosti-servisa-Merkuri-03-31 |
| Пользовательское соглашение | https://telegra.ph/Polzovatelskoe-soglashenie-servisa-Merkuri-03-31 |
| Согласие на обработку ПД | https://telegra.ph/Soglasie-na-obrabotku-personalnyh-dannyh-03-31-19 |

Статус: черновики у юриста на согласовании.
Хранение данных: Supabase Frankfurt (EU) — нужно перенести на RU до рекламы (ФЗ-152).

---

## 15. КАК РАБОТАТЬ С CLAUDE CODE

### Запуск
```bash
cd ~/Documents/mercury-bot
claude
```

### Стандартный деплой после правок
```bash
git add .
git commit -m "описание"
git push
```

### Формат задач для Claude Code
Описывать проблему + ожидаемое поведение + где искать в коде.
Одна задача = один промпт = один деплой.

### Если нужно посмотреть файл
```
Покажи содержимое файла src/cabinetRoutes.js
```

---

*Этот файл обновлять после каждой значимой сессии разработки.*
