// Отписка от писем: персональная ссылка с подписью (без отдельной таблицы токенов) и страницы подтверждения.
//  GET  /unsubscribe?u=<id>&t=<подпись>  — страница «Отписаться?» с кнопкой (само открытие ссылки ничего не меняет,
//                                           иначе почтовые сканеры отписывали бы людей автоматически)
//  POST /unsubscribe                     — отписка (форма на странице или «в один клик» из почтового клиента)
//  POST /unsubscribe  action=resubscribe — вернуть письма
import crypto from 'crypto';
import express from 'express';
import { escapeHtml } from '../utils/email.js';

function secret() {
  const s = process.env.UNSUBSCRIBE_SECRET || process.env.JWT_SECRET;
  if (!s) throw new Error('UNSUBSCRIBE_SECRET or JWT_SECRET is not set');
  return s;
}

export function unsubToken(userId, key = secret()) {
  return crypto.createHmac('sha256', key).update(`unsub:${userId}`).digest('base64url').slice(0, 32);
}

export function verifyUnsubToken(userId, token, key = secret()) {
  if (typeof userId !== 'string' || typeof token !== 'string') return false;
  const a = Buffer.from(unsubToken(userId, key));
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function unsubscribeUrl(userId, base = 'https://finnikbot.ru') {
  return `${base.replace(/\/+$/, '')}/unsubscribe?u=${encodeURIComponent(userId)}&t=${unsubToken(userId)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function page(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)}</title>
<style>
body{margin:0;background:#EEF2F6;font-family:Arial,Helvetica,sans-serif;color:#1E2A38}
.box{max-width:480px;margin:48px auto;padding:32px;background:#fff;border-radius:24px;text-align:center}
h1{font-size:22px;margin:0 0 12px}p{font-size:16px;line-height:1.4;margin:0 0 16px}
button{background:#1E2A38;color:#fff;border:0;border-radius:10px;padding:10px 20px;font-size:14px;font-weight:600;cursor:pointer}
button.green{background:#2FBF71}a{color:#4C9AFF}.small{font-size:13px;color:#6B7280}
</style></head><body><div class="box">${bodyHtml}</div></body></html>`;
}

const invalidPage = page('Ссылка недействительна', `<h1>Ссылка недействительна</h1>
<p>Возможно, она скопировалась не полностью. Напиши нам на <a href="mailto:hello@finnikbot.ru">hello@finnikbot.ru</a>, и мы отключим письма вручную.</p>`);

function confirmPage(u, t) {
  return page('Отписаться от писем Финника', `<h1>Отписаться от писем?</h1>
<p>Мы перестанем присылать письма о возможностях Финника. Важные сообщения о сроке пробного периода и подписки продолжат приходить.</p>
<form method="post" action="/unsubscribe">
<input type="hidden" name="u" value="${escapeHtml(u)}"><input type="hidden" name="t" value="${escapeHtml(t)}">
<button type="submit">Да, отписаться</button></form>`);
}

function donePage(u, t) {
  return page('Вы отписались', `<h1>Готово, ты отписался 👌</h1>
<p>Писем о возможностях Финника больше не будет. Важные сообщения о сроке доступа продолжат приходить.</p>
<form method="post" action="/unsubscribe">
<input type="hidden" name="u" value="${escapeHtml(u)}"><input type="hidden" name="t" value="${escapeHtml(t)}"><input type="hidden" name="action" value="resubscribe">
<p class="small">Передумал? <button class="green" type="submit">Вернуть письма</button></p></form>`);
}

function resubPage() {
  return page('Письма возвращены', `<h1>Письма снова включены 💛</h1><p>Будем присылать только полезное. <a href="https://finnikbot.ru/cabinet/bot">Открыть Финника</a></p>`);
}

export function createEmailRouter({ db }) {
  const router = express.Router();
  const form = express.urlencoded({ extended: false, limit: '4kb' });

  router.get('/unsubscribe', (req, res) => {
    const { u, t } = req.query;
    res.set('Cache-Control', 'no-store');
    if (!UUID_RE.test(String(u ?? '')) || !verifyUnsubToken(String(u), String(t ?? ''))) {
      return res.status(400).send(invalidPage);
    }
    res.send(confirmPage(String(u), String(t)));
  });

  router.post('/unsubscribe', form, async (req, res) => {
    // Из формы данные приходят в теле, из почтового клиента («в один клик») — в адресе запроса
    const u = String(req.body?.u ?? req.query?.u ?? '');
    const t = String(req.body?.t ?? req.query?.t ?? '');
    const action = String(req.body?.action ?? '');
    res.set('Cache-Control', 'no-store');
    if (!UUID_RE.test(u) || !verifyUnsubToken(u, t)) return res.status(400).send(invalidPage);

    try {
      if (action === 'resubscribe') {
        const { error } = await db.from('users').update({ email_letters_accepted: true, email_unsubscribed_at: null }).eq('id', u);
        if (error) throw new Error(error.message);
        return res.send(resubPage());
      }
      const { error } = await db
        .from('users')
        .update({ email_letters_accepted: false, email_unsubscribed_at: new Date().toISOString() })
        .eq('id', u);
      if (error) throw new Error(error.message);
      console.log(`[unsubscribe] user ${u.slice(0, 8)} unsubscribed`);
      return res.send(donePage(u, t));
    } catch (err) {
      console.error('[unsubscribe] error:', err.message);
      return res.status(500).send(page('Ошибка', '<h1>Что-то пошло не так</h1><p>Попробуй ещё раз чуть позже или напиши нам на hello@finnikbot.ru.</p>'));
    }
  });

  return router;
}
