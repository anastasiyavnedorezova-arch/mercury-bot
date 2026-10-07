// Чистая логика проверки здоровья: решает, когда слать письмо, а когда молчать.
// Без сети и файлов — поэтому её легко проверять тестами.

export const FAIL_THRESHOLD = 2;                    // сколько проверок подряд должно упасть, чтобы послать тревогу
export const REMINDER_EVERY_MS = 6 * 60 * 60 * 1000; // напоминание, пока проблема не ушла

const EMPTY = { fails: 0, alerted: false, lastAlertAt: 0, since: 0 };

/**
 * @param {{checks?: Record<string, {fails:number, alerted:boolean, lastAlertAt:number, since:number}>}} prevState
 * @param {{name:string, ok:boolean, detail?:string}[]} results
 * @param {number} now  миллисекунды
 * @returns {{ state: object, actions: {kind:'alert'|'reminder'|'recovered', name:string, detail?:string, since:number}[] }}
 */
export function evaluate(prevState, results, now) {
  const prevChecks = (prevState && prevState.checks) || {};
  const checks = {};
  const actions = [];

  for (const r of results) {
    const prev = { ...EMPTY, ...(prevChecks[r.name] || {}) };
    if (r.ok) {
      if (prev.alerted) actions.push({ kind: 'recovered', name: r.name, since: prev.since });
      checks[r.name] = { ...EMPTY };
      continue;
    }
    const fails = prev.fails + 1;
    const since = prev.fails === 0 ? now : prev.since;
    const next = { fails, alerted: prev.alerted, lastAlertAt: prev.lastAlertAt, since };
    if (fails >= FAIL_THRESHOLD && !prev.alerted) {
      next.alerted = true;
      next.lastAlertAt = now;
      actions.push({ kind: 'alert', name: r.name, detail: r.detail, since });
    } else if (prev.alerted && now - prev.lastAlertAt >= REMINDER_EVERY_MS) {
      next.lastAlertAt = now;
      actions.push({ kind: 'reminder', name: r.name, detail: r.detail, since });
    }
    checks[r.name] = next;
  }
  return { state: { checks }, actions };
}

// Если письмо отправить не удалось — состояние откатываем, чтобы следующий запуск попробовал снова.
export function revertOnSendFailure(prevState, state, actions) {
  const prevChecks = (prevState && prevState.checks) || {};
  const checks = { ...state.checks };
  for (const a of actions) {
    const prev = { ...EMPTY, ...(prevChecks[a.name] || {}) };
    if (a.kind === 'recovered') {
      checks[a.name] = { ...prev, fails: 0 }; // всё ещё считаем, что тревога висит
    } else {
      checks[a.name] = { ...checks[a.name], alerted: prev.alerted, lastAlertAt: prev.lastAlertAt };
    }
  }
  return { checks };
}

const LABELS = {
  app: 'Сайт и бот (приложение на сервере)',
  db: 'База данных',
  telegram: 'Связь бота с Telegram',
  openai: 'Связь бота с OpenAI',
};
export const labelOf = (name) => LABELS[name] || name;

const HINTS = {
  telegram: 'Бот не сможет получать и отправлять сообщения. Сначала проверьте ретранслятор в Нидерландах (relay.finnikbot.ru).',
  openai: 'Бот не сможет распознавать записи. Сначала проверьте ретранслятор в Нидерландах (relay.finnikbot.ru) и ключ OpenAI.',
  app: 'Приложение не отвечает на самом сервере. Проверьте: systemctl status finnik.',
  db: 'Приложение не достаёт до базы. Проверьте: systemctl status postgresql.',
};

const fmtMsk = (ms) =>
  new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' }).format(new Date(ms));

// Собирает одно письмо из всех событий запуска
export function buildEmail(actions, now) {
  const problems = actions.filter((a) => a.kind !== 'recovered');
  const fixed = actions.filter((a) => a.kind === 'recovered');
  const lines = [];
  for (const a of problems) {
    lines.push(`${a.kind === 'reminder' ? 'Всё ещё не работает' : 'Не работает'}: ${labelOf(a.name)}`);
    if (a.detail) lines.push(`Что видим: ${a.detail}`);
    if (HINTS[a.name]) lines.push(HINTS[a.name]);
    lines.push(`С какого времени (МСК): ${fmtMsk(a.since)}`, '');
  }
  for (const a of fixed) {
    lines.push(`Снова работает: ${labelOf(a.name)}`, `Проблема началась (МСК): ${fmtMsk(a.since)}`, '');
  }
  lines.push(`Проверка выполнена: ${fmtMsk(now)} МСК`);

  let subject;
  if (problems.length) {
    subject = `🔴 Финник: проблема — ${problems.map((a) => labelOf(a.name)).join(', ')}`;
  } else {
    subject = `🟢 Финник: восстановлено — ${fixed.map((a) => labelOf(a.name)).join(', ')}`;
  }
  const text = lines.join('\n');
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = lines.map((l) => (l ? `<p>${esc(l)}</p>` : '')).join('');
  return { subject: subject.slice(0, 250), text, html };
}
