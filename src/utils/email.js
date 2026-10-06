import crypto from 'crypto';

// Экранирует HTML-спецсимволы. Нестрока → ''
export function escapeHtml(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 'anna@gmail.com' → 'a***@gmail.com'
export function maskEmail(email) {
  if (typeof email !== 'string' || !email.includes('@')) return '***';
  const [local, domain] = email.split('@');
  return `${local[0] ?? ''}***@${domain}`;
}

// Убрать HTML-теги для генерации text из html
function stripTags(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Отправляет письмо через RuSender.
 * Никогда не бросает исключение.
 * @returns {{ ok: true, uuid: string } | { ok: false, skipped?: true, status?: number, error?: string }}
 */
export async function sendEmail({ to, toName, subject, text, html, idempotencyKey }) {
  // Читаем env при каждом вызове
  const apiToken = process.env.RUSENDER_API_TOKEN;
  const keyId = process.env.RUSENDER_KEY_ID;
  const fromEmail = process.env.MAIL_FROM_EMAIL;
  const fromName = process.env.MAIL_FROM_NAME || 'Финник';

  if (!apiToken || !keyId || !fromEmail) {
    console.warn('[email] not configured, skipped');
    return { ok: false, skipped: true };
  }

  if (!to || !subject) return { ok: false, error: 'bad_args' };
  if (/[\r\n]/.test(subject)) return { ok: false, error: 'bad_args' };

  const subjectTrimmed = subject.slice(0, 255);
  const iKey = (idempotencyKey ?? crypto.randomUUID()).slice(0, 150);

  // Генерируем text из html если нужно
  const finalHtml = html || undefined;
  const finalText = text || (html ? stripTags(html) : undefined);

  const body = {
    idempotencyKey: iKey,
    mail: {
      to: { email: to, name: toName || '' },
      from: { email: fromEmail, name: fromName },
      subject: subjectTrimmed,
      ...(finalHtml ? { html: finalHtml } : {}),
      ...(finalText ? { text: finalText } : {}),
    },
  };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10_000);

  try {
    const res = await fetch(
      `https://api.rusender.ru/api/v1/external-mails/send/${keyId}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      }
    );
    clearTimeout(timer);

    if (res.ok) {
      let uuid;
      try { uuid = (await res.json()).uuid; } catch (_) {}
      console.log(`[email] sent to ${maskEmail(to)}, status 200`);
      return { ok: true, uuid };
    }

    let code;
    try { code = (await res.json()).code; } catch (_) {}
    console.error(`[email] error ${res.status}${code ? ' code=' + code : ''} to ${maskEmail(to)}`);
    return { ok: false, status: res.status, error: code };
  } catch (err) {
    clearTimeout(timer);
    console.error(`[email] network error to ${maskEmail(to)}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Отправляет приветственное письмо после регистрации.
 * Никогда не бросает исключение.
 */
export async function sendWelcomeEmail({ to, name, userId } = {}) {
  if (process.env.WELCOME_EMAIL_ENABLED === 'false') {
    return { ok: false, skipped: true };
  }

  const safeName = escapeHtml((name ?? '').slice(0, 100));
  const greeting = safeName ? `Привет, ${safeName}!` : 'Привет!';
  const greetingText = safeName ? `Привет, ${(name ?? '').slice(0, 100)}!` : 'Привет!';

  const html = `<p>${greeting}</p>
<p>Вы зарегистрировались в Финнике — помощнике для учета личных финансов.</p>
<p>Записывать расходы или доходы можно обычным сообщением боту в личном кабинете: <a href="https://finnikbot.ru/cabinet/dashboard">finnikbot.ru/cabinet/dashboard</a> — или в Telegram: <a href="https://t.me/FinnikMoneyBot">t.me/FinnikMoneyBot</a>.</p>
<p>Если возникнут вопросы, просто напишите нам на почту <a href="mailto:hello@finnikbot.ru">hello@finnikbot.ru</a>.</p>
<p>Поддержка Финника</p>`;

  const text = `${greetingText}

Вы зарегистрировались в Финнике — помощнике для учета личных финансов.

Записывать расходы или доходы можно обычным сообщением боту в личном кабинете: https://finnikbot.ru/cabinet/dashboard — или в Telegram: https://t.me/FinnikMoneyBot.

Если возникнут вопросы, просто напишите нам на почту hello@finnikbot.ru.

Поддержка Финника`;

  const iKey = userId ? `welcome-${userId}` : crypto.randomUUID();

  return sendEmail({
    to,
    subject: 'Добро пожаловать в Финник',
    html,
    text,
    idempotencyKey: iKey,
  });
}

// Возвращает статус наличия почтовых переменных (только true/false, без значений).
export function emailConfigStatus() {
  return {
    RUSENDER_API_TOKEN: !!process.env.RUSENDER_API_TOKEN,
    RUSENDER_KEY_ID: !!process.env.RUSENDER_KEY_ID,
    MAIL_FROM_EMAIL: !!process.env.MAIL_FROM_EMAIL,
    ADMIN_NOTIFY_EMAIL: !!process.env.ADMIN_NOTIFY_EMAIL,
    WELCOME_EMAIL_ENABLED: process.env.WELCOME_EMAIL_ENABLED !== 'false',
  };
}
