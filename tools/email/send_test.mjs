// Отправляет тестовые письма на указанную почту (кнопка отписки в таких письмах ведёт на страницу-заглушку).
//   node tools/email/send_test.mjs <ключ_письма|all> <почта>
// Запускать на сервере, где настроены ключи RuSender (см. инструкцию в сообщении). Баннеры берутся с сайта,
// поэтому файлы из public/email/banners/ должны быть уже выложены.
import { sendEmail } from '../../src/utils/email.js';
import { LETTER_KEYS, renderLetter } from '../../src/emails/letters.js';

process.env.JWT_SECRET ||= 'test-send-only';
const [, , which, to] = process.argv;
if (!which || !to) {
  console.log(`Использование: node tools/email/send_test.mjs <${LETTER_KEYS.join('|')}|all> <почта>`);
  process.exit(1);
}
const keys = which === 'all' ? LETTER_KEYS : [which];
for (const key of keys) {
  const { subject, html, text } = renderLetter(key, { userId: '00000000-0000-4000-8000-000000000000' });
  const res = await sendEmail({ to, subject: `[ТЕСТ] ${subject}`, html, text, idempotencyKey: `test-${key}-${Date.now()}` });
  console.log(key, res.ok ? 'отправлено' : `ошибка: ${JSON.stringify(res)}`);
  await new Promise((r) => setTimeout(r, 1500));
}
