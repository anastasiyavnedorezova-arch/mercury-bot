# Тестовая среда (stage)

Копия Финника на том же сервере: отдельная база `finnik_stage`, отдельный тестовый бот, адрес https://stage.finnikbot.ru, порт 3001.
Боевых пользователей и их записей здесь нет: аккаунты регистрируются заново.

## Установка (один раз)
```
STAGE_BOT_TOKEN="токен_тестового_бота" bash /opt/finnik/app/deploy/stage/setup-stage.sh
```

## Рабочий порядок
1. Изменения пушатся в ветку `staging`: `git push origin HEAD:staging`.
2. На сервере: `finnik-stage-deploy.sh` (если ветки `staging` нет, берётся `main`).
3. Проверка на https://stage.finnikbot.ru и в тестовом боте.
4. Всё хорошо — изменения попадают в `main`, на сервере: `finnik-deploy.sh`.

Миграции базы применяются вручную и к `finnik_stage`, и к `finnik`.
Файл настроек: `/etc/finnik-stage.env` (права 600), служба: `finnik-stage`.
