// Сводка цифр для владельца: команда /stats в боте (только ADMIN_TELEGRAM_ID). Только читает базу.
// Окна — «последние N суток от сейчас».
// Не считаются: склеенные аккаунты (merged_into), оплаты со статусом refunded и бесплатные выдачи (amount_rub пусто или 0).

const PAID = `s.payment_id IS NOT NULL AND s.status <> 'refunded' AND COALESCE(s.amount_rub, 0) > 0`;
const REAL_USER = `u.merged_into IS NULL AND u.channel <> 'merged'`;

const clampDays = (n) => {
  const v = Number.parseInt(n, 10);
  return Number.isFinite(v) && v >= 1 ? Math.min(v, 365) : 30;
};

/** Подпись источника: utm_source/utm_medium/utm_campaign, либо «сайт: ref», либо «без метки». */
export function sourceLabel({ src, med, camp, ref } = {}) {
  const parts = [src, med, camp].filter(Boolean);
  if (parts.length) return parts.join(' / ');
  if (ref) return `сайт: ${ref}`;
  return 'без метки';
}

/**
 * Собирает цифры одним чтением в транзакции.
 * @param {object} db клиент базы (нужен db.transaction)
 * @param {{ days?: number|string }} [opts]
 */
export async function collectStats(db, { days } = {}) {
  const d = clampDays(days);
  const run = (fn) => db.transaction(fn);
  return run(async (tx) => {
    const q = async (text, params = []) => (await tx.query(text, params)).rows;
    const win = `now() - make_interval(days => $1::int)`;

    const [users] = await q(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE u.created_at >= now() - interval '1 day')::int AS d1,
              count(*) FILTER (WHERE u.created_at >= now() - interval '7 days')::int AS d7,
              count(*) FILTER (WHERE u.created_at >= ${win})::int AS dn
         FROM public.users u WHERE ${REAL_USER}`,
      [d],
    );
    const [now_] = await q(
      `SELECT (SELECT count(DISTINCT s.user_id) FROM public.subscriptions s
                WHERE s.status = 'trial' AND s.ends_at > now())::int AS trial_now,
              (SELECT count(DISTINCT s.user_id) FROM public.subscriptions s
                WHERE s.status = 'active' AND ${PAID} AND s.ends_at > now())::int AS paying_now`,
    );
    const cohort = await q(
      `WITH c AS (
         SELECT u.utm,
                EXISTS (SELECT 1 FROM public.transactions t WHERE t.user_id = u.id) AS rec,
                EXISTS (SELECT 1 FROM public.subscriptions s WHERE s.user_id = u.id AND ${PAID}) AS paid,
                COALESCE((SELECT sum(s.amount_rub) FROM public.subscriptions s WHERE s.user_id = u.id AND ${PAID}), 0) AS rub
           FROM public.users u
          WHERE ${REAL_USER} AND u.created_at >= ${win})
       SELECT utm->>'utm_source' AS src, utm->>'utm_medium' AS med, utm->>'utm_campaign' AS camp, utm->>'ref' AS ref,
              count(*)::int AS regs,
              count(*) FILTER (WHERE rec)::int AS recs,
              count(*) FILTER (WHERE paid)::int AS paid,
              COALESCE(sum(rub), 0)::int AS rub
         FROM c GROUP BY 1, 2, 3, 4 ORDER BY regs DESC, rub DESC`,
      [d],
    );
    const [pay] = await q(
      `SELECT count(*) FILTER (WHERE s.created_at >= ${win})::int AS n,
              COALESCE(sum(s.amount_rub) FILTER (WHERE s.created_at >= ${win}), 0)::int AS rub,
              count(*)::int AS n_all,
              COALESCE(sum(s.amount_rub), 0)::int AS rub_all
         FROM public.subscriptions s WHERE ${PAID}`,
      [d],
    );
    let ai = null;
    try {
      const [r] = await q(
        `SELECT COALESCE(sum(requests), 0)::int AS weights, count(*)::int AS person_days
           FROM public.ai_usage
          WHERE subject <> '*' AND day > (now() AT TIME ZONE 'Europe/Moscow')::date - 7`,
      );
      ai = r;
    } catch { ai = null; }
    return { days: d, users, now: now_, cohort, pay, ai };
  });
}

const rub = (n) => `${Number(n || 0).toLocaleString('ru-RU')} ₽`;
const pct = (a, b) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '—');

/** Превращает цифры в текст для Telegram (обычный текст, без разметки). */
export function formatStats(s, { maxSources = 10 } = {}) {
  const regs = s.cohort.reduce((a, r) => a + r.regs, 0);
  const recs = s.cohort.reduce((a, r) => a + r.recs, 0);
  const paid = s.cohort.reduce((a, r) => a + r.paid, 0);
  const lines = [];
  lines.push(`📊 Финник — цифры (последние ${s.days} дн.)`);
  lines.push('');
  lines.push('Люди');
  lines.push(`Всего зарегистрировано= ${s.users.total}`);
  lines.push(`За сутки= ${s.users.d1}, за 7 дн.= ${s.users.d7}, за ${s.days} дн.= ${s.users.dn}`);
  lines.push(`Сейчас на триале= ${s.now.trial_now}, с оплаченной подпиской= ${s.now.paying_now}`);
  lines.push('');
  lines.push(`Воронка (зарегистрировались за ${s.days} дн.)`);
  lines.push(`Регистраций= ${regs}`);
  lines.push(`Сделали первую запись= ${recs} (${pct(recs, regs)})`);
  lines.push(`Оплатили= ${paid} (${pct(paid, regs)})`);
  lines.push('');
  lines.push('Деньги');
  lines.push(`За ${s.days} дн.= ${s.pay.n} платежей на ${rub(s.pay.rub)}`);
  lines.push(`За всё время= ${s.pay.n_all} платежей на ${rub(s.pay.rub_all)}`);
  lines.push('');
  lines.push(`По источникам (зарегистрировались за ${s.days} дн.)`);
  if (!s.cohort.length) lines.push('пока никого');
  const shown = s.cohort.slice(0, maxSources);
  for (const r of shown) {
    lines.push(`${sourceLabel(r)}= ${r.regs} рег, ${r.recs} с записью, ${r.paid} оплатили, ${rub(r.rub)}`);
  }
  if (s.cohort.length > shown.length) {
    const rest = s.cohort.slice(shown.length).reduce((a, r) => a + r.regs, 0);
    lines.push(`ещё ${s.cohort.length - shown.length} источников= ${rest} рег`);
  }
  lines.push('');
  if (s.ai && s.ai.person_days > 0) {
    lines.push(`ИИ за 7 дн.= в среднем ${(s.ai.weights / s.ai.person_days).toFixed(1).replace('.', ',')} запросов на человека в активный день (всего ${s.ai.weights})`);
  } else {
    lines.push('ИИ за 7 дн.= данных пока нет');
  }
  lines.push('');
  lines.push('В цифры входят и твои тестовые аккаунты. Возвраты (статус refunded) и бесплатные выдачи не считаются выручкой.');
  return lines.join('\n');
}

export const parseStatsCommand = (text) => {
  const m = /^\/stats(?:@\w+)?(?:\s+(\d{1,3}))?\s*$/.exec(String(text ?? '').trim());
  return m ? { days: clampDays(m[1]) } : null;
};
