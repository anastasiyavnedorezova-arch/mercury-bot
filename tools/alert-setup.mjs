// Помогает узнать ALERT_CHAT_ID для бота оповещений. Порядок:
//   1) создай бота в @BotFather, токен впиши на сервере в /etc/finnik-prod.env строкой ALERT_BOT_TOKEN=… (сама, не в чат)
//   2) открой этого бота в Telegram и нажми «Запустить» / напиши ему любое слово
//   3) на сервере из папки приложения:  node --env-file=/etc/finnik-prod.env tools/alert-setup.mjs
// Скрипт покажет номер чата (ALERT_CHAT_ID), токен он не печатает. Впиши номер в тот же файл строкой ALERT_CHAT_ID=…
import { telegramApiBase } from '../src/utils/endpoints.js';

const token = (process.env.ALERT_BOT_TOKEN || '').trim();
if (!token) { console.error('Нет ALERT_BOT_TOKEN в окружении. Впиши его в /etc/finnik-prod.env и запусти с --env-file=/etc/finnik-prod.env'); process.exit(1); }

try {
  const res = await fetch(`${telegramApiBase()}/bot${token}/getUpdates`, { signal: AbortSignal.timeout(15000) });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) { console.error(`Telegram ответил статусом ${res.status}. Проверь токен.`); process.exit(1); }
  const chats = new Map();
  for (const u of body.result) {
    const c = (u.message || u.edited_message || u.my_chat_member)?.chat;
    if (c) chats.set(c.id, c);
  }
  if (!chats.size) { console.log('Сообщений боту пока нет. Открой бота в Telegram, нажми «Запустить» и запусти скрипт ещё раз.'); process.exit(0); }
  for (const c of chats.values()) console.log(`ALERT_CHAT_ID=${c.id}   (${c.type}${c.first_name ? ', ' + c.first_name : ''}${c.username ? ', @' + c.username : ''})`);
} catch (err) {
  console.error('Не удалось связаться с Telegram:', err?.cause?.code || err?.message);
  process.exit(1);
}
