#!/bin/bash
# Внешний сторож: каждые 5 минут (таймер systemd) заходит на сайт СНАРУЖИ и, если сайт не отвечает два раза подряд,
# пишет в Telegram боту оповещений НАПРЯМУЮ (не через основной сервер). Работает на ретрансляторе (relay.finnikbot.ru):
# если упадёт весь основной сервер, это единственное, что об этом скажет.
# Настройки в /etc/finnik-watch.env (права 600): ALERT_BOT_TOKEN, ALERT_CHAT_ID; необязательно WATCH_URL, ALERT_PROJECT.
#   finnik-watch.sh          — обычная проверка
#   finnik-watch.sh --test   — отправить тестовое сообщение
set -u
ENV_FILE="${WATCH_ENV_FILE:-/etc/finnik-watch.env}"
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && . "$ENV_FILE"
URL="${WATCH_URL:-https://finnikbot.ru/cabinet/login}"
PROJECT="${ALERT_PROJECT:-Финник}"
TG_API="${TG_API:-https://api.telegram.org}"
STATE_DIR="${STATE_DIRECTORY:-/var/lib/finnik-watch}"
FAIL_THRESHOLD="${WATCH_FAIL_THRESHOLD:-2}"
REMIND_EVERY="${WATCH_REMIND_EVERY:-21600}"   # напоминание раз в 6 часов, пока сайт не ответит
mkdir -p "$STATE_DIR"

msk() { TZ=Europe/Moscow date -d "@$1" '+%d.%m %H:%M'; }

# 0 — отправлено
send() {
  [ -n "${ALERT_BOT_TOKEN:-}" ] && [ -n "${ALERT_CHAT_ID:-}" ] || { echo "[watch] не заданы ALERT_BOT_TOKEN / ALERT_CHAT_ID"; return 1; }
  local code
  code=$(curl -sS -m 15 -o /dev/null -w '%{http_code}' -X POST "$TG_API/bot${ALERT_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${ALERT_CHAT_ID}" --data-urlencode "text=$1" 2>/dev/null) || code=000
  [ "$code" = "200" ] || { echo "[watch] Telegram не принял сообщение (код $code)"; return 1; }
}

if [ "${1:-}" = "--test" ]; then
  send "🧪 Проект: ${PROJECT}. Внешний сторож работает: проверяю ${URL} каждые 5 минут." && echo "[watch] тест отправлен" || exit 1
  exit 0
fi

now=$(date +%s)
fails=$(cat "$STATE_DIR/fails" 2>/dev/null || echo 0)
since=$(cat "$STATE_DIR/since" 2>/dev/null || echo "$now")
alerted=$(cat "$STATE_DIR/alerted" 2>/dev/null || echo 0)

code=$(curl -sS -m 15 -o /dev/null -w '%{http_code}' "$URL" 2>/dev/null) || code=000
if [ "$code" = "200" ]; then
  echo "[watch] $URL: ok"
  if [ "$alerted" != "0" ]; then
    send "Проект: ${PROJECT}

🟢 Сайт снова отвечает (проблема была с $(msk "$since") МСК)

Проверка: $(msk "$now") МСК" || { echo "[watch] сообщение о восстановлении не ушло, попробую в следующий раз"; exit 0; }
  fi
  rm -f "$STATE_DIR/fails" "$STATE_DIR/since" "$STATE_DIR/alerted"
  exit 0
fi

fails=$((fails + 1))
[ "$fails" -eq 1 ] && since=$now
echo "[watch] $URL: сбой $fails подряд (код $code)"
echo "$fails" > "$STATE_DIR/fails"; echo "$since" > "$STATE_DIR/since"

text="Проект: ${PROJECT}

🔴 Сайт не отвечает снаружи: ${URL} (код ${code})
С $(msk "$since") МСК

Если бот и кабинет не открываются, проверь сервер в панели хостинга и перезапусти его. Письмо от проверки здоровья может не прийти, если лёг весь сервер.

Проверка: $(msk "$now") МСК"

if [ "$fails" -ge "$FAIL_THRESHOLD" ] && [ "$alerted" = "0" ]; then
  send "$text" && echo "$now" > "$STATE_DIR/alerted"
elif [ "$alerted" != "0" ] && [ $((now - alerted)) -ge "$REMIND_EVERY" ]; then
  send "Всё ещё не отвечает.

$text" && echo "$now" > "$STATE_DIR/alerted"
fi
exit 0
