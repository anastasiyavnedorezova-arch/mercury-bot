import { getRealBot } from '../realBot.js';
import { sendEmail, escapeHtml } from './email.js';

/**
 * Уведомляет администратора об обращении пользователя — письмом и сообщением в Telegram.
 * Никогда не бросает исключение.
 * @param {{ source: 'web'|'telegram', from: string, text: string }}
 * @returns {{ telegram: boolean, email: boolean }}
 */
export async function notifyAdminAboutFeedback({ source, from, text }) {
  const label = source === 'web' ? 'сайт' : 'Telegram';
  let telegram = false;
  let email = false;

  // 1. Telegram-уведомление администратору
  try {
    const adminId = process.env.ADMIN_TELEGRAM_ID;
    if (adminId) {
      const truncated = (text ?? '').slice(0, 3500);
      await getRealBot().sendMessage(
        adminId,
        `📩 Новое обращение (${label})\nОт: ${from}\n\n${truncated}`
      );
      telegram = true;
    }
  } catch (err) {
    console.error('[feedbackNotify] telegram error:', err.message);
  }

  // 2. Email-уведомление администратору
  try {
    const adminEmail = process.env.ADMIN_NOTIFY_EMAIL || process.env.MAIL_FROM_EMAIL;
    if (adminEmail) {
      const safeFrom = escapeHtml(from ?? '');
      const safeText = escapeHtml(text ?? '').replace(/\n/g, '<br>');
      const html = `<p><b>Обращение через ${escapeHtml(label)}</b></p><p>От: ${safeFrom}</p><p>${safeText}</p>`;
      const plain = `Обращение через ${label}\nОт: ${from ?? ''}\n\n${text ?? ''}`;
      const r = await sendEmail({
        to: adminEmail,
        subject: `Обращение в Финник (${label})`,
        html,
        text: plain,
      });
      email = r.ok;
    }
  } catch (err) {
    console.error('[feedbackNotify] email error:', err.message);
  }

  return { telegram, email };
}
