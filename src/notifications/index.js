import { supabase } from '../db.js';

// ── Хелперы дат ───────────────────────────────────────────────────────────────

function getMonthStart(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

function getNextMonthStart(d = new Date()) {
  const y = d.getMonth() === 11 ? d.getFullYear() + 1 : d.getFullYear();
  const m = d.getMonth() === 11 ? 1 : d.getMonth() + 2;
  return `${y}-${String(m).padStart(2, '0')}-01`;
}

function dateStrUTC(d) {
  return d.toISOString().split('T')[0];
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function formatNum(n) {
  return Math.round(n).toLocaleString('ru-RU');
}

function daysWord(n) {
  if (n % 100 >= 11 && n % 100 <= 19) return 'дней';
  const r = n % 10;
  if (r === 1) return 'день';
  if (r >= 2 && r <= 4) return 'дня';
  return 'дней';
}

// ── DB-хелперы ────────────────────────────────────────────────────────────────

async function getActiveUsers() {
  const thirtyDaysAgo = addDays(new Date(), -30).toISOString();
  const { data, error } = await supabase
    .from('users')
    .select('id, external_id, username')
    .eq('channel', 'telegram')
    .not('terms_accepted_at', 'is', null)
    .gte('last_active_at', thirtyDaysAgo);

  if (error) {
    // last_active_at может отсутствовать — fallback: все пользователи с согласием
    const { data: allUsers } = await supabase
      .from('users')
      .select('id, external_id, username')
      .eq('channel', 'telegram')
      .not('terms_accepted_at', 'is', null);
    return allUsers ?? [];
  }

  return data ?? [];
}

async function getSubscription(userId) {
  const { data } = await supabase
    .from('subscriptions')
    .select('status, ends_at')
    .eq('user_id', userId)
    .maybeSingle();
  return data ?? { status: 'free', ends_at: null };
}

async function hasNotification(userId, type, month = null) {
  let query = supabase
    .from('notifications')
    .select('id')
    .eq('user_id', userId)
    .eq('type', type);
  if (month) query = query.eq('month', month);
  const { data } = await query.maybeSingle();
  return !!data;
}

async function countNotifications(userId, type, sinceIso) {
  const { count } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('type', type)
    .gte('created_at', sinceIso);
  return count ?? 0;
}

async function recordNotification(userId, type, month = null) {
  const record = { user_id: userId, type };
  if (month) record.month = month;
  await supabase.from('notifications').insert(record);
}

// ── 1. Напоминание задать бюджет ──────────────────────────────────────────────

export async function checkBudgetReminders(bot) {
  console.log('[budget_reminder] checking users...');
  const today = new Date().getDate();
  if (![1, 3, 5].includes(today)) {
    console.log('[budget_reminder] skip — today is', today);
    return;
  }

  const thisMonthStart = getMonthStart();
  const nextMonthStart = getNextMonthStart();
  const users = await getActiveUsers();
  console.log('[budget_reminder] total users:', users.length);

  for (const user of users) {
    try {
      const sub = await getSubscription(user.id);
      console.log('[budget_reminder] user:', user.id, 'access:', sub.status);

      if (sub.status === 'trial' || sub.status === 'active') {
        const { data: budget } = await supabase
          .from('budget')
          .select('id')
          .eq('user_id', user.id)
          .gte('month', thisMonthStart)
          .lt('month', nextMonthStart)
          .maybeSingle();

        console.log('[budget_reminder] has budget:', !!budget);

        if (!budget) {
          const alreadyReminded = await hasNotification(user.id, 'budget_reminder', thisMonthStart);
          console.log('[budget_reminder] already reminded:', alreadyReminded);
          if (alreadyReminded) continue;

          await bot.sendMessage(
            user.external_id,
            'Давай зададим бюджет на месяц 💰\n' +
            'Тогда я смогу отслеживать темп расходов и заранее мягко ' +
            'предупредить, если в этом месяце есть риск потратить ' +
            'больше, чем хотелось бы.',
            {
              reply_markup: {
                inline_keyboard: [[{ text: 'Установить бюджет', callback_data: 'start_budget' }]],
              },
            }
          );
          await recordNotification(user.id, 'budget_reminder', thisMonthStart);
        }
      } else if ((sub.status === 'free' || sub.status === 'expired') && today === 3) {
        const alreadyReminded = await hasNotification(user.id, 'budget_reminder', thisMonthStart);
        console.log('[budget_reminder] already reminded (free):', alreadyReminded);
        if (alreadyReminded) continue;

        await bot.sendMessage(
          user.external_id,
          'Хочешь ещё более внимательно управлять своими финансами? ' +
          'Можем добавить бюджет на месяц 🤑\n' +
          'Функция установки и контроля бюджета доступна в подписке.',
          {
            reply_markup: {
              inline_keyboard: [[{ text: 'Оформить подписку', callback_data: 'menu:subscription' }]],
            },
          }
        );
        await recordNotification(user.id, 'budget_reminder', thisMonthStart);
      }
    } catch (err) {
      console.error(`[checkBudgetReminders] user ${user.external_id}:`, err.message);
    }
  }
}

// ── 2. Напоминание вносить записи ─────────────────────────────────────────────

export async function checkActivityReminders(bot) {
  console.log('[activity] checking users...');
  const users = await getActiveUsers();
  console.log('[activity] total users:', users.length);
  const threeDaysAgoStr = dateStrUTC(addDays(new Date(), -3));
  const thirtyDaysAgoIso = addDays(new Date(), -30).toISOString();

  for (const user of users) {
    try {
      console.log('[activity] user:', user.id, 'last_active:', user.last_active_at ?? 'n/a');

      const { data: recentTx } = await supabase
        .from('transactions')
        .select('id, transaction_date')
        .eq('user_id', user.id)
        .gte('transaction_date', threeDaysAgoStr)
        .limit(1);

      if (recentTx?.length > 0) {
        console.log('[activity] user:', user.id, '— has recent tx, skip');
        continue;
      }

      const { data: lastTx } = await supabase
        .from('transactions')
        .select('transaction_date')
        .eq('user_id', user.id)
        .order('transaction_date', { ascending: false })
        .limit(1);
      const daysSinceLastTx = lastTx?.[0]
        ? Math.floor((Date.now() - new Date(lastTx[0].transaction_date).getTime()) / 86_400_000)
        : null;
      console.log('[activity] days since last transaction:', daysSinceLastTx);

      const count = await countNotifications(user.id, 'activity_reminder', thirtyDaysAgoIso);
      console.log('[activity] reminders sent this month:', count);
      if (count >= 4) continue;

      if (count === 3) {
        await bot.sendMessage(
          user.external_id,
          'Похоже ты пока не готов продолжать. Я рядом, ' +
          'когда понадоблюсь. Возвращайся в любой момент 💛'
        );
      } else {
        await bot.sendMessage(
          user.external_id,
          'Небольшое напоминание 💛\n' +
          'Чтобы я мог точнее показывать твою финансовую картину, ' +
          'не забывай записывать доходы и расходы. Внесём данные?',
          {
            reply_markup: {
              inline_keyboard: [[
                { text: 'Записать расход или доход', callback_data: 'menu:add' },
              ]],
            },
          }
        );
      }

      await recordNotification(user.id, 'activity_reminder');
    } catch (err) {
      console.error(`[checkActivityReminders] user ${user.external_id}:`, err.message);
    }
  }
}

// ── 3. Алерты превышения бюджета ──────────────────────────────────────────────

export async function checkBudgetAlerts(bot) {
  const now = new Date();
  const dayOfMonth = now.getDate();
  const thisMonthStart = getMonthStart();
  const nextMonthStart = getNextMonthStart();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const remainingDays = daysInMonth - dayOfMonth;

  console.log('[budget_alerts] checking users...');

  const { data: budgets } = await supabase
    .from('budget')
    .select('user_id, amount')
    .gte('month', thisMonthStart)
    .lt('month', nextMonthStart);

  console.log('[budget_alerts] total users with budget:', budgets?.length ?? 0);
  if (!budgets?.length) return;

  const { data: nonSystemCats } = await supabase
    .from('categories')
    .select('id')
    .eq('is_system', false);

  const catIds = nonSystemCats?.map(c => c.id) ?? [];

  for (const budget of budgets) {
    try {
      const sub = await getSubscription(budget.user_id);
      if (!['trial', 'active'].includes(sub.status)) continue;

      const { data: userRow } = await supabase
        .from('users')
        .select('id, external_id')
        .eq('id', budget.user_id)
        .single();
      if (!userRow) continue;

      let spentQuery = supabase
        .from('transactions')
        .select('amount')
        .eq('user_id', budget.user_id)
        .eq('type', 'expense')
        .gte('transaction_date', thisMonthStart)
        .lt('transaction_date', nextMonthStart);

      if (catIds.length > 0) spentQuery = spentQuery.in('category_id', catIds);

      const { data: txData } = await spentQuery;
      const spent = (txData ?? []).reduce((s, t) => s + t.amount, 0);
      const pct = budget.amount > 0 ? (spent / budget.amount) * 100 : 0;

      console.log('[budget_alerts] user:', userRow.id, 'spent:', spent, 'budget:', budget.amount, 'percent:', Math.round(pct), 'day_of_month:', dayOfMonth);

      // Триггер 1: дни 1–10, >= 50%
      if (dayOfMonth <= 10 && pct >= 50) {
        const alert50sent = await hasNotification(userRow.id, 'budget_alert_50', thisMonthStart);
        console.log('[budget_alerts] alert_50_sent:', alert50sent);
        if (!alert50sent) {
          await bot.sendMessage(
            userRow.external_id,
            '📌 Ранний сигнал: ты уже потратил половину бюджета, ' +
            'а месяц только начался. Пока всё под контролем, ' +
            'но стоит немного притормозить.'
          );
          await recordNotification(userRow.id, 'budget_alert_50', thisMonthStart);
        }
      }

      // Триггер 2: дни 1–20, >= 80%
      if (dayOfMonth <= 20 && pct >= 80) {
        const alert80sent = await hasNotification(userRow.id, 'budget_alert_80', thisMonthStart);
        console.log('[budget_alerts] alert_80_sent:', alert80sent);
        if (!alert80sent) {
          await bot.sendMessage(
            userRow.external_id,
            `📌 80% бюджета уже израсходовано, а до конца месяца ` +
            `ещё ${remainingDays} ${daysWord(remainingDays)}. ` +
            `Хочешь посмотреть, на что уходит больше?`,
            {
              reply_markup: {
                inline_keyboard: [[
                  { text: 'На что трачу больше', callback_data: 'analytics_top_month' },
                ]],
              },
            }
          );
          await recordNotification(userRow.id, 'budget_alert_80', thisMonthStart);
        }
      }

      // Триггер 3: после 20-го, прогноз >= 100%
      if (dayOfMonth > 20) {
        const avgDaily = dayOfMonth > 0 ? spent / dayOfMonth : 0;
        const forecast = spent + avgDaily * remainingDays;
        const overrun = Math.round(forecast - budget.amount);

        if (forecast >= budget.amount) {
          if (!await hasNotification(userRow.id, 'budget_alert_forecast', thisMonthStart)) {
            await bot.sendMessage(
              userRow.external_id,
              `📌 По текущему темпу бюджет к концу месяца будет превышен ` +
              `примерно на ${formatNum(overrun)} ₽. ` +
              `Можно скорректировать расходы — хочешь посмотреть детали?`,
              {
                reply_markup: {
                  inline_keyboard: [[
                    { text: 'Прогноз до конца месяца', callback_data: 'analytics_forecast' },
                  ]],
                },
              }
            );
            await recordNotification(userRow.id, 'budget_alert_forecast', thisMonthStart);
          }
        }
      }
    } catch (err) {
      console.error(`[checkBudgetAlerts] user_id ${budget.user_id}:`, err.message);
    }
  }
}

// ── 4. Окончание trial ────────────────────────────────────────────────────────

export async function checkTrialEnding(bot) {
  console.log('[trial_ending] checking users...');
  const now = new Date();
  const todayStr   = dateStrUTC(now);
  const in1dayStr  = dateStrUTC(addDays(now, 1));
  const in3daysStr = dateStrUTC(addDays(now, 3));

  const { data: subs } = await supabase
    .from('subscriptions')
    .select('user_id, ends_at')
    .eq('status', 'trial');

  console.log('[trial_ending] found:', subs?.length ?? 0);
  if (!subs?.length) return;

  for (const sub of subs) {
    try {
      const { data: user } = await supabase
        .from('users')
        .select('id, external_id')
        .eq('id', sub.user_id)
        .single();
      if (!user) continue;

      const endsAtStr = dateStrUTC(new Date(sub.ends_at));
      const daysLeft = Math.ceil((new Date(sub.ends_at).getTime() - Date.now()) / 86_400_000);
      console.log('[trial_ending] user:', user.id, 'ends_at:', endsAtStr, 'days_left:', daysLeft);

      // Истёк
      if (endsAtStr < todayStr) {
        await supabase.from('subscriptions')
          .update({ status: 'expired' })
          .eq('user_id', sub.user_id);

        console.log('[trial_ending] sending notification (expired) to:', user.id);
        await bot.sendMessage(
          user.external_id,
          'Пробный период завершился 🫣\nНо я по-прежнему с тобой 💛',
          {
            reply_markup: {
              inline_keyboard: [[
                { text: 'Оформить подписку', callback_data: 'menu:subscription' },
              ]],
            },
          }
        );
        console.log('[trial_ending] sent to:', user.id);
        continue;
      }

      // За 3 дня
      if (endsAtStr === in3daysStr) {
        const alreadyNotified3 = await hasNotification(user.id, 'trial_ending_3');
        console.log('[trial_ending] already_notified_3:', alreadyNotified3);
        if (!alreadyNotified3) {
          console.log('[trial_ending] sending notification (3 days) to:', user.id);
          await bot.sendMessage(
            user.external_id,
            'Твой пробный период скоро закончится — осталось 3 дня 🔔\n' +
            'Чтобы сохранить доступ ко всем возможностям бота, ' +
            'можно заранее продлить подписку.',
            {
              reply_markup: {
                inline_keyboard: [[
                  { text: 'Оплатить подписку', callback_data: 'menu:subscription' },
                ]],
              },
            }
          );
          await recordNotification(user.id, 'trial_ending_3');
          console.log('[trial_ending] sent to:', user.id);
        }
      }

      // За 1 день
      if (endsAtStr === in1dayStr) {
        const alreadyNotified1 = await hasNotification(user.id, 'trial_ending_1');
        console.log('[trial_ending] already_notified_1:', alreadyNotified1);
        if (!alreadyNotified1) {
          console.log('[trial_ending] sending notification (1 day) to:', user.id);
          await bot.sendMessage(
            user.external_id,
            'Завтра закончится твой пробный период 🔔\n' +
            'Но я всегда рядом. У тебя бесплатно останется:\n' +
            '✔️ 1 финансовая цель\n' +
            '✔️ ведение доходов и расходов\n' +
            '✔️ общая аналитика по итогам месяца',
            {
              reply_markup: {
                inline_keyboard: [[
                  { text: 'Оплатить подписку', callback_data: 'menu:subscription' },
                ]],
              },
            }
          );
          await recordNotification(user.id, 'trial_ending_1');
          console.log('[trial_ending] sent to:', user.id);
        }
      }
    } catch (err) {
      console.error(`[checkTrialEnding] user_id ${sub.user_id}:`, err.message);
    }
  }
}

// ── 5. Окончание платной подписки ─────────────────────────────────────────────

export async function checkSubscriptionEnding(bot) {
  const now = new Date();
  const todayStr   = dateStrUTC(now);
  const in1dayStr  = dateStrUTC(addDays(now, 1));
  const in3daysStr = dateStrUTC(addDays(now, 3));

  const { data: subs } = await supabase
    .from('subscriptions')
    .select('user_id, ends_at')
    .eq('status', 'active');

  if (!subs?.length) return;

  for (const sub of subs) {
    try {
      const { data: user } = await supabase
        .from('users')
        .select('id, external_id')
        .eq('id', sub.user_id)
        .single();
      if (!user) continue;

      const endsAtStr = dateStrUTC(new Date(sub.ends_at));

      // Истёк
      if (endsAtStr < todayStr) {
        await supabase.from('subscriptions')
          .update({ status: 'expired' })
          .eq('user_id', sub.user_id);

        await bot.sendMessage(
          user.external_id,
          'Подписка завершилась 🫣\nНо я по-прежнему с тобой 💛',
          {
            reply_markup: {
              inline_keyboard: [[
                { text: 'Оформить подписку', callback_data: 'menu:subscription' },
              ]],
            },
          }
        );
        continue;
      }

      // За 3 дня
      if (endsAtStr === in3daysStr) {
        if (!await hasNotification(user.id, 'subscription_ending_3')) {
          await bot.sendMessage(
            user.external_id,
            'Твоя подписка заканчивается через 3 дня 🔔\n' +
            'Чтобы не потерять доступ ко всем возможностям, можно заранее продлить.',
            {
              reply_markup: {
                inline_keyboard: [[
                  { text: 'Продлить подписку', callback_data: 'menu:subscription' },
                ]],
              },
            }
          );
          await recordNotification(user.id, 'subscription_ending_3');
        }
      }

      // За 1 день
      if (endsAtStr === in1dayStr) {
        if (!await hasNotification(user.id, 'subscription_ending_1')) {
          await bot.sendMessage(
            user.external_id,
            'Завтра заканчивается твоя подписка 🔔\n' +
            'Продли сегодня, чтобы не прерываться.',
            {
              reply_markup: {
                inline_keyboard: [[
                  { text: 'Продлить подписку', callback_data: 'menu:subscription' },
                ]],
              },
            }
          );
          await recordNotification(user.id, 'subscription_ending_1');
        }
      }
    } catch (err) {
      console.error(`[checkSubscriptionEnding] user_id ${sub.user_id}:`, err.message);
    }
  }
}
