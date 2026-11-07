// Independent incident state for each destination. A successful Telegram send
// must not suppress an email retry, or cause the other email to be sent twice.
import { evaluate, revertOnSendFailure, buildEmail, buildTelegramText } from './healthLogic.js';
import { sendEmail, maskEmail } from './email.js';
import { alertConfigured, sendTelegramAlert } from './alertTelegram.js';

export function healthAlertRecipients(env = process.env) {
  const raw = env.HEALTH_ALERT_EMAILS?.trim() || env.ADMIN_NOTIFY_EMAIL || env.MAIL_FROM_EMAIL || '';
  const recipients = raw.split(/[,;]/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (recipients.some((s) => !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(s))) {
    throw new Error('Invalid health alert email configuration');
  }
  return [...new Set(recipients)];
}

export async function sendHealthTestEmail(env = process.env, send = sendEmail) {
  const recipients = healthAlertRecipients(env);
  if (!recipients.length) return [{ ok: false, error: 'no_recipient' }];
  return Promise.all(recipients.map(async (to) => {
    try {
      const result = await send({
        to,
        subject: `🧪 ${env.ALERT_PROJECT || 'Финник'}: тест оповещений`,
        text: 'Это тестовое письмо проверки здоровья Финника. Проверяется доставка внутренних оповещений владельцу.',
      });
      return { ...result, destination: maskEmail(to) };
    } catch { return { ok: false, destination: maskEmail(to), error: 'send_failed' }; }
  }));
}

export async function dispatchHealthAlerts(previous, results, now, env = process.env, {
  sendEmailImpl = sendEmail, sendTelegramImpl = sendTelegramAlert,
} = {}) {
  const recipients = healthAlertRecipients(env);
  const project = env.ALERT_PROJECT?.trim() || 'Финник';
  const legacyEmail = (env.ADMIN_NOTIFY_EMAIL || env.MAIL_FROM_EMAIL || '').trim().toLowerCase();
  const targets = recipients.map((to) => ({
    id: `email:${to}`, label: `email:${maskEmail(to)}`, legacy: to === legacyEmail,
    send: (actions) => {
      const mail = buildEmail(actions, now);
      return sendEmailImpl({ to, ...mail, subject: `[${project}] ${mail.subject}` });
    },
  }));
  if (alertConfigured(env)) targets.push({
    id: 'telegram', label: 'Telegram', legacy: true,
    send: (actions) => sendTelegramImpl(buildTelegramText(actions, now, project), env),
  });
  const deliveries = {};
  const outcomes = await Promise.all(targets.map(async (target) => {
    // Only the old email and Telegram inherit the old shared state. A newly
    // added recipient must independently reach its two-failure threshold.
    const prev = previous?.deliveries?.[target.id]
      || (!previous?.deliveries && target.legacy ? { checks: previous?.checks || {} } : {});
    const { state, actions } = evaluate(prev, results, now);
    if (!actions.length) {
      deliveries[target.id] = state;
      return { destination: target.label, skipped: true };
    }
    let sent;
    try { sent = await target.send(actions); }
    catch { sent = { ok: false }; }
    deliveries[target.id] = sent?.ok ? state : revertOnSendFailure(prev, state, actions);
    return { destination: target.label, ok: Boolean(sent?.ok),
      actions: actions.map((a) => `${a.kind}:${a.name}`) };
  }));
  return {
    state: { ...evaluate(previous, results, now).state, version: 2, deliveries },
    outcomes,
    configured: targets.length > 0,
  };
}
