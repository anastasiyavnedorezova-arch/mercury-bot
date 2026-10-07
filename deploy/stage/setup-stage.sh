#!/bin/bash
# Разовая установка тестовой среды Финника на сервере. Запускать от root:
#   STAGE_BOT_TOKEN="токен_ТЕСТОВОГО_бота" bash /opt/finnik/app/deploy/stage/setup-stage.sh
# Создаёт: базу finnik_stage (+ системные категории), копию кода /opt/finnik-stage/app, файл настроек
# /etc/finnik-stage.env, службу finnik-stage (порт 3001), сертификат и nginx для stage.finnikbot.ru.
# Боевую базу и боевую службу не меняет (только читает системные категории).
set -euo pipefail
cd /tmp

DOMAIN=stage.finnikbot.ru
SRC=/opt/finnik/app
DEST=/opt/finnik-stage
PROD_ENV=/etc/finnik-prod.env
STAGE_ENV=/etc/finnik-stage.env
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[ "$(id -u)" -eq 0 ] || { echo "ОШИБКА: запускайте от root"; exit 1; }
[ -n "${STAGE_BOT_TOKEN:-}" ] || { echo "ОШИБКА: не передан STAGE_BOT_TOKEN"; exit 1; }
[ -f "$PROD_ENV" ] || { echo "ОШИБКА: нет $PROD_ENV"; exit 1; }
[ -f /root/.secrets/cloudflare.ini ] || { echo "ОШИБКА: нет /root/.secrets/cloudflare.ini"; exit 1; }

PROD_TOKEN="$(grep -m1 '^TELEGRAM_BOT_TOKEN=' "$PROD_ENV" | cut -d= -f2- | tr -d "\"'")"
[ "$STAGE_BOT_TOKEN" != "$PROD_TOKEN" ] || { echo "ОШИБКА: это токен БОЕВОГО бота. Нужен токен тестового"; exit 1; }
case "$STAGE_BOT_TOKEN" in *[!A-Za-z0-9:_-]*|'') echo "ОШИБКА: в токене лишние символы"; exit 1;; esac

if [ -e "$DEST" ] || [ -e "$STAGE_ENV" ] || [ -e /etc/systemd/system/finnik-stage.service ] \
   || sudo -u postgres psql -Atc "select 1 from pg_database where datname='finnik_stage'" | grep -q 1; then
  echo "ОШИБКА: тестовая среда уже существует (папка, настройки, служба или база). Ничего не трогаю."
  exit 1
fi

echo "1/8 Создаю базу finnik_stage"
DBPW="$(openssl rand -hex 16)"
JWT="$(openssl rand -hex 32)"
printf '%s\n' "CREATE ROLE finnik_stage LOGIN PASSWORD :'pw';" | sudo -u postgres psql -q -v ON_ERROR_STOP=1 -v pw="$DBPW"
sudo -u postgres psql -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE finnik_stage OWNER finnik_stage TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER icu ICU_LOCALE 'ru-RU' LOCALE 'C.UTF-8'"
STAGE_URL="postgresql://finnik_stage:${DBPW}@127.0.0.1:5432/finnik_stage"

echo "2/8 Создаю таблицы"
psql "$STAGE_URL" -q -v ON_ERROR_STOP=1 -f "$SRC/db/schema.sql" >/dev/null
psql "$STAGE_URL" -q -v ON_ERROR_STOP=1 -f "$SRC/db/migrations/001_own_auth.sql" >/dev/null

echo "3/8 Копирую системные категории (пользователей и их записи НЕ копирую)"
sudo -u postgres psql -q -d finnik -c "COPY category_groups TO STDOUT" \
  | sudo -u postgres psql -q -d finnik_stage -v ON_ERROR_STOP=1 -c "COPY category_groups FROM STDIN"
sudo -u postgres psql -q -d finnik -c "COPY (SELECT * FROM categories WHERE user_id IS NULL) TO STDOUT" \
  | sudo -u postgres psql -q -d finnik_stage -v ON_ERROR_STOP=1 -c "COPY categories FROM STDIN"
echo "  групп категорий: $(psql "$STAGE_URL" -Atc 'select count(*) from category_groups'), категорий: $(psql "$STAGE_URL" -Atc 'select count(*) from categories')"

echo "4/8 Копирую код в $DEST/app"
mkdir -p "$DEST"
cp -a "$SRC" "$DEST/app"

echo "5/8 Собираю файл настроек $STAGE_ENV"
STAGE_PORT=3001 STAGE_DATABASE_URL="$STAGE_URL" STAGE_JWT_SECRET="$JWT" \
STAGE_APP_BASE_URL="https://$DOMAIN" STAGE_BOT_TOKEN="$STAGE_BOT_TOKEN" \
  python3 "$HERE/make_stage_env.py" "$PROD_ENV" "$STAGE_ENV"
chown root:root "$STAGE_ENV"; chmod 600 "$STAGE_ENV"

echo "6/8 Ставлю службу finnik-stage и скрипт выкладки"
cp "$HERE/finnik-stage.service" /etc/systemd/system/finnik-stage.service
cp "$HERE/finnik-stage-deploy.sh" /usr/local/bin/finnik-stage-deploy.sh
chmod 755 /usr/local/bin/finnik-stage-deploy.sh
systemctl daemon-reload
systemctl enable --now finnik-stage

echo "7/8 Получаю сертификат для $DOMAIN"
if [ ! -d "/etc/letsencrypt/live/$DOMAIN" ]; then
  certbot certonly --non-interactive --agree-tos -m hello@finnikbot.ru \
    --dns-cloudflare --dns-cloudflare-credentials /root/.secrets/cloudflare.ini \
    --dns-cloudflare-propagation-seconds 30 -d "$DOMAIN"
fi

echo "8/8 Настраиваю nginx"
cp "$HERE/nginx-stage.conf" /etc/nginx/sites-available/finnik-stage
ln -sf /etc/nginx/sites-available/finnik-stage /etc/nginx/sites-enabled/finnik-stage
nginx -t
systemctl reload nginx

sleep 5
echo
echo "=== Проверка ==="
echo "служба: $(systemctl is-active finnik-stage)"
echo "локально (порт 3001): $(curl -s -o /dev/null -w '%{http_code}' -H 'X-Forwarded-Proto: https' http://127.0.0.1:3001/cabinet/login)"
echo "по адресу https://$DOMAIN: $(curl -s -o /dev/null -w '%{http_code}' https://$DOMAIN/cabinet/login)"
journalctl -u finnik-stage -n 8 --no-pager
echo "ГОТОВО"
