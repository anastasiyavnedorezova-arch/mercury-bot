# Ретранслятор (relay.finnikbot.ru) и внешний сторож

Ретранслятор — маленький сервер за границей с nginx: через него основной сервер ходит в Telegram и OpenAI
(`TELEGRAM_API_BASE_URL=https://relay.finnikbot.ru/telegram`, `OPENAI_BASE_URL=https://relay.finnikbot.ru/openai/v1`).
Пускает только IP основного сервера (`allow` в `nginx-relay.conf`).

## Что будет, если ретранслятор упал
- Бот не получает и не отправляет сообщения в Telegram, ИИ-разбор записей не работает.
- Сайт, вход, оплата и кабинет продолжают работать; чат в кабинете отвечает ошибкой.
- Тревога: проверка здоровья на основном сервере (каждые 5 минут) видит сбой связи с Telegram и OpenAI и шлёт письмо на hello@.
  В Telegram тревога в этом случае не придёт (она идёт через тот же ретранслятор): смотри почту.
- Данные не теряются: записи, которые люди не смогли отправить, просто не дошли до бота.

## Быстрое восстановление (15 минут): новый ретранслятор
1. Новый маленький VPS за границей (Ubuntu, 1 ГБ памяти достаточно), ssh-доступ.
2. `apt update && apt install -y nginx certbot python3-certbot-nginx`.
3. DNS: A-запись `relay.finnikbot.ru` → IP нового сервера (поставь маленький TTL, 300 секунд). Дождись, пока `dig +short relay.finnikbot.ru` покажет новый IP.
4. Положи `nginx-relay.conf` в `/etc/nginx/sites-enabled/relay`, но сначала оставь в нём только первый блок (`listen 80`, без строки `return 301`): сертификата ещё нет. `nginx -t && systemctl reload nginx`.
5. `certbot certonly --nginx -d relay.finnikbot.ru`, затем верни файл целиком и `nginx -t && systemctl reload nginx`.
6. Проверка с основного сервера: `curl -s https://relay.finnikbot.ru/telegram/bot1:x/getMe` — должен прийти ответ Telegram вида `{"ok":false,"error_code":401,"description":"Unauthorized"}` (значит, цепочка работает). `403` или пусто — не пускает nginx (проверь `allow`), `502` — ретранслятор не достаёт до Telegram.
7. Дальше всё сам подхватит бот: перезапуск не нужен (адрес прежний), через 5–10 минут придёт письмо «восстановлено».
Сертификат продлевается сам (`certbot.timer`), срок следит проверка здоровья на основном сервере (тревога за 14 дней).

## Внешний сторож (запускается на ретрансляторе)
Заходит на `https://finnikbot.ru/cabinet/login` каждые 5 минут. После двух сбоев подряд пишет в Telegram боту оповещений напрямую
(`api.telegram.org`, не через основной сервер): единственное, что сообщит о падении всего основного сервера.

Установка (на ретрансляторе, от root, из папки с файлами этого каталога):
```
install -m 755 finnik-watch.sh /usr/local/bin/finnik-watch.sh
install -m 644 finnik-watch.service finnik-watch.timer /etc/systemd/system/
# токен и чат вписываются в /etc/finnik-watch.env (права 600), токен вводить без показа на экране:
read -rsp "Токен: " T; echo; printf 'ALERT_BOT_TOKEN=%s\nALERT_CHAT_ID=ЧАТ\n' "$T" > /etc/finnik-watch.env; unset T; chmod 600 /etc/finnik-watch.env
systemctl daemon-reload && systemctl enable --now finnik-watch.timer
/usr/local/bin/finnik-watch.sh --test      # в Telegram придёт тестовое сообщение
```
