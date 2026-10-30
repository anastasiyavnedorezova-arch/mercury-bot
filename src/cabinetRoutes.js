import { Router } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { isWebAccount } from './auth/authCore.js';
import { supabase } from './db.js';
import { requireAuth as requireJwt, requireActiveAccount } from './authMiddleware.js';
import { createWebBotAdapter, getWebChatQueue, clearWebChatQueue, waitForNewMessage } from './webBotAdapter.js';
import { handleMessage } from './handlers/message.js';
import { showMainMenu } from './handlers/menu.js';
import { maybeShowWebWelcome } from './handlers/onboarding.js';
import { dispatchCallbackQuery } from './handlers/callbackDispatcher.js';
import { inTz, monthStartStr, monthEndStr } from './utils/dateTz.js';
import { notifyAdminAboutFeedback } from './utils/feedbackNotify.js';
import { getUserAccess } from './utils/access.js';
import { hadTrial, startTrial, rowsHadTrial } from './utils/trial.js';
import { createUserCategory, updateUserCategory, listGroups, mapCategoryRow } from './cabinet/categories.js';
import { updateTransaction } from './cabinet/historyEdit.js';
import { addGoalContribution } from './cabinet/goalContribution.js';
import { isUuid } from './cabinet/categories.js';
import { splitGoals, getWorkingGoalId, setWorkingGoal } from './utils/goalAccess.js';
import { rateLimit, userKey } from './utils/httpLimits.js';
import { displayMessage } from './utils/messageText.js';
import { getContributions, goalSaved } from './utils/goalProgress.js';
import { createLinkToken, disconnectTelegram, botLinkUrl, botUsername, LINK_TTL_MS } from './accounts/linkTelegram.js';

const webBot = createWebBotAdapter();

const router = Router();

// Сеанс должен быть с действующим токеном и с действующим (не удалённым, не объединённым) аккаунтом.
const requireAuth = [requireJwt, requireActiveAccount(supabase)];

// Ограничения частоты (см. utils/httpLimits.js). Лимиты ставятся после проверки входа, чтобы считать по человеку.
const limitTelegramLogin = rateLimit({ name: 'telegram-login', windowMs: 15 * 60_000, max: 30 });
const limitFeedback = [
  rateLimit({ name: 'feedback-user', windowMs: 60 * 60_000, max: 5, key: userKey, message: 'Слишком много обращений. Попробуй чуть позже.' }),
  rateLimit({ name: 'feedback-ip', windowMs: 60 * 60_000, max: 20, message: 'Слишком много обращений. Попробуй чуть позже.' }),
];
const limitGoalTopUp = rateLimit({ name: 'goal-topup', windowMs: 60_000, max: 20, key: userKey, message: 'Слишком часто. Подожди минутку и попробуй снова.' });
const limitTelegramLink = rateLimit({ name: 'telegram-link', windowMs: 60 * 60_000, max: 10, key: userKey, message: 'Слишком часто. Подожди немного и попробуй снова.' });
// Веб-чат: 30 сообщений в минуту. Лишнее сообщение не доходит до ИИ; человек получает ответ бота в чате (индикатор «печатает» не зависает).
const limitChatSend = rateLimit({
  name: 'chat-send', windowMs: 60_000, max: 30, key: userKey,
  onLimited: async (req, res) => {
    try {
      const chatId = await getOrCreateWebChatId(req.userId);
      await webBot.sendMessage(chatId, 'Ты пишешь очень часто 🙂 Подожди минутку и отправь ещё раз.');
    } catch (e) {
      console.error('[webchat] limit notice error:', e.message);
    }
    res.json({ ok: true });
  },
});

// ──────────────────────────────────────────
// Хелпер: возвращает chatId для веб-чата
// Если у пользователя уже есть telegram external_id — используем его.
// Если нет — генерируем псевдо-id вида "web_<userId>".
// ──────────────────────────────────────────
async function getOrCreateWebChatId(userId) {
  const { data: user } = await supabase
    .from('users')
    .select('external_id, channel')
    .eq('id', userId)
    .single();

  if (user?.external_id && user?.channel === 'telegram') {
    return user.external_id;
  }

  if (user?.external_id && user?.channel === 'web') {
    return user.external_id;
  }

  const webId = 'web_' + userId;
  await supabase
    .from('users')
    .update({ external_id: webId, channel: 'web' })
    .eq('id', userId)
    .is('external_id', null);

  return webId;
}

// ──────────────────────────────────────────
// POST /api/auth/telegram
// Принимает данные Telegram Login Widget,
// проверяет HMAC-SHA256, возвращает JWT.
// ──────────────────────────────────────────
router.post('/api/auth/telegram', limitTelegramLogin, async (req, res) => {
  try {
    const { hash, ...data } = req.body;
    if (!hash) return res.status(400).json({ error: 'Missing hash' });

    // Проверка подписи
    const checkString = Object.keys(data)
      .sort()
      .map((k) => `${k}=${data[k]}`)
      .join('\n');

    const secretKey = crypto
      .createHash('sha256')
      .update(process.env.TELEGRAM_BOT_TOKEN)
      .digest();

    const expectedHash = crypto
      .createHmac('sha256', secretKey)
      .update(checkString)
      .digest('hex');

    if (expectedHash !== hash) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // Проверяем давность — не старше 24 часов
    if (Date.now() / 1000 - Number(data.auth_date) > 86400) {
      return res.status(401).json({ error: 'Auth data expired' });
    }

    const telegramId = String(data.id);

    // Ищем пользователя по telegram_id
    const { data: users, error } = await supabase
      .from('users')
      .select('id, external_id, channel, status')
      .eq('external_id', telegramId)
      .eq('channel', 'telegram')
      .limit(1);

    if (error) throw error;

    if (!users?.length || ['deleted', 'merged'].includes(users[0].status ?? 'active')) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userId = users[0].id;

    const token = jwt.sign(
      { userId, telegramId },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      token,
      user: {
        id: userId,
        telegramId,
        firstName: data.first_name ?? null,
        lastName: data.last_name ?? null,
        username: data.username ?? null,
        photoUrl: data.photo_url ?? null,
      },
    });
  } catch (err) {
    console.error('[cabinet] /auth/telegram error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────
// GET /api/me
// ──────────────────────────────────────────
router.get('/api/me', requireAuth, async (req, res) => {
  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('id, external_id, channel, created_at, tg_username, web_username, email')
      .eq('id', req.userId)
      .single();

    if (error || !user) return res.status(404).json({ error: 'User not found' });

    const { data: subRows, error: subError } = await supabase
      .from('subscriptions')
      .select('status, starts_at, ends_at, period_months')
      .eq('user_id', req.userId)
      .in('status', ['trial', 'active'])
      .gt('ends_at', new Date().toISOString())
      .order('ends_at', { ascending: false })
      .limit(1);

    const sub = subRows?.[0] ?? null;

    if (subError) console.error('[api/me] sub error:', subError.message);

    const username = user.web_username || user.tg_username || user.email || null;
    res.json({ ...user, username, subscription: sub ?? null });
  } catch (err) {
    console.error('[cabinet] /api/me error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────
// GET /api/transactions?limit=20&offset=0&month=2026-06
// ──────────────────────────────────────────
router.get('/api/transactions', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = parseInt(req.query.offset) || 0;

    let query = supabase
      .from('transactions')
      .select(
        'id, type, amount, comment, transaction_date, categories(name, category_groups(name))',
        { count: 'exact' }
      )
      .eq('user_id', req.userId)
      .order('transaction_date', { ascending: false })
      .range(offset, offset + limit - 1);

    if (req.query.month) {
      const [year, month] = req.query.month.split('-').map(Number);
      if (!year || !month || month < 1 || month > 12) {
        return res.status(400).json({ error: 'Invalid month' });
      }
      const from = monthStartStr(year, month);
      const to = monthEndStr(year, month);
      query = query.gte('transaction_date', from).lte('transaction_date', to);
    }

    const { data, error, count } = await query;
    if (error) throw error;

    res.json({ data, total: count, limit, offset });
  } catch (err) {
    console.error('[cabinet] /api/transactions error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────
// GET /api/goals
// ──────────────────────────────────────────
router.get('/api/goals', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('goals')
      .select('*')
      .eq('user_id', req.userId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    // saved = стартовая сумма + взносы именно на эту цель (то же число, что в боте и на Дашборде)
    const contributions = await getContributions(supabase, req.userId);
    // Тариф free: рабочая цель одна, остальные закрыты (locked): смотреть и удалять можно
    const access = await getUserAccess(req.userId);
    const active = (data || []).filter((g) => g.status === 'active');
    const workingId = access === 'free' ? await getWorkingGoalId(supabase, req.userId) : null;
    const lockedIds = new Set(splitGoals(active, access, workingId).locked.map((g) => g.id));
    res.json({
      data: (data || []).map((g) => ({ ...g, saved: goalSaved(g, contributions), locked: lockedIds.has(g.id) })),
      access,
    });
  } catch (err) {
    console.error('[cabinet] /api/goals error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────
// POST /api/goals/:id/contribute — «Пополнить» цель: { amount }
// ──────────────────────────────────────────
router.post('/api/goals/:id/contribute', requireAuth, limitGoalTopUp, async (req, res) => {
  try {
    const access = await getUserAccess(req.userId);
    const r = await addGoalContribution(supabase, req.userId, req.params.id, req.body, undefined, access);
    res.status(r.status).json(r.json);
  } catch (err) {
    console.error('[cabinet] POST /api/goals/:id/contribute error:', err.message);
    res.status(500).json({ error: 'Internal server error', message: 'Не удалось записать взнос. Попробуй ещё раз' });
  }
});

// ──────────────────────────────────────────
// POST /api/goals/:id/work — «Сделать рабочей» (тариф free: рабочая цель одна)
// ──────────────────────────────────────────
router.post('/api/goals/:id/work', requireAuth, limitGoalTopUp, async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'Not found', message: 'Цель не найдена' });
    const r = await setWorkingGoal(supabase, req.userId, req.params.id);
    if (!r.ok) return res.status(404).json({ error: 'Not found', message: 'Цель не найдена' });
    res.json({ ok: true, working_goal_id: r.goal.id });
  } catch (err) {
    console.error('[cabinet] POST /api/goals/:id/work error:', err.message);
    res.status(500).json({ error: 'Internal server error', message: 'Не удалось выбрать цель. Попробуй ещё раз' });
  }
});

// ──────────────────────────────────────────
// DELETE /api/goals/:id
// ──────────────────────────────────────────
router.delete('/api/goals/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase
      .from('goals')
      .delete()
      .eq('id', id)
      .eq('user_id', req.userId);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[cabinet] DELETE /api/goals/:id error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────
// GET /api/budget/all — все бюджеты пользователя
// ──────────────────────────────────────────
router.get('/api/budget/all', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('budget')
      .select('month, amount')
      .eq('user_id', req.userId)
      .order('month', { ascending: false });

    if (error) throw error;
    res.json({ data });
  } catch (err) {
    console.error('[cabinet] /api/budget/all error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────
// GET /api/budget?month=2026-06
// ──────────────────────────────────────────
router.get('/api/budget', requireAuth, async (req, res) => {
  try {
    const monthParam = req.query.month;
    let monthDate;

    if (monthParam) {
      const [year, month] = monthParam.split('-').map(Number);
      if (!year || !month || month < 1 || month > 12) {
        return res.status(400).json({ error: 'Invalid month' });
      }
      monthDate = monthStartStr(year, month);
    } else {
      const now = inTz();
      monthDate = monthStartStr(now.getFullYear(), now.getMonth() + 1);
    }

    const { data, error } = await supabase
      .from('budget')
      .select('*')
      .eq('user_id', req.userId)
      .eq('month', monthDate);

    if (error) throw error;
    res.json({ data, month: monthDate });
  } catch (err) {
    console.error('[cabinet] /api/budget error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────
// GET /api/dashboard
// Возвращает все данные для главной страницы кабинета
// ──────────────────────────────────────────
router.get('/api/dashboard', requireAuth, async (req, res) => {
  try {
    const now = new Date();
    const nowTz = inTz(now);
    const monthStart = monthStartStr(nowTz.getFullYear(), nowTz.getMonth() + 1);

    const [userRes, subRes, txRes, goalsRes] = await Promise.all([
      supabase.from('users').select('id, external_id, tg_username, web_username, email').eq('id', req.userId).single(),
      supabase.from('subscriptions')
        .select('status, ends_at')
        .eq('user_id', req.userId)
        .in('status', ['trial', 'active'])
        .gt('ends_at', now.toISOString())
        .order('ends_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase.from('transactions')
        .select('id, type, amount, comment, raw_message, transaction_date, categories(name)')
        .eq('user_id', req.userId)
        .gte('transaction_date', monthStart)
        .order('transaction_date', { ascending: false }),
      supabase.from('goals')
        .select('id, name, target_amount, future_value, initial_saved, target_date')
        .eq('user_id', req.userId)
        .eq('status', 'active')
        .order('created_at', { ascending: false }),
    ]);

    if (userRes.error) throw userRes.error;
    if (txRes.error) throw txRes.error;
    if (goalsRes.error) throw goalsRes.error;

    const user = userRes.data;
    const sub = subRes.data;
    const transactions = txRes.data || [];
    const goals = goalsRes.data || [];

    // Взносы по целям: у каждой цели свои (transactions.goal_id)
    const contributions = await getContributions(supabase, req.userId);

    // Ни одной записи за всё время: кабинет сам откроет чат с приветствием (патч 56)
    const { count: txTotal } = await supabase
      .from('transactions')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', req.userId);

    // Баланс текущего месяца
    let income = 0, expenses = 0;
    transactions.forEach(t => {
      const amt = parseFloat(t.amount) || 0;
      if (t.type === 'income') income += amt;
      else if (t.type === 'expense') expenses += amt;
    });

    // Топ-5 категорий расходов этого месяца
    const catTotals = {};
    transactions.filter(t => t.type === 'expense').forEach(t => {
      const name = t.categories?.name || 'Другое';
      catTotals[name] = (catTotals[name] || 0) + (parseFloat(t.amount) || 0);
    });
    const top_categories = Object.entries(catTotals)
      .map(([name, amount]) => ({ name, amount }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 5);

    // Последние 10 транзакций
    const recent_transactions = transactions.slice(0, 10).map(t => ({
      id: t.id,
      type: t.type,
      amount: t.amount,
      comment: displayMessage(t, t.categories?.name),
      date: t.transaction_date,
      category: t.categories?.name || 'Другое',
    }));

    // Цели: saved = initial_saved + взносы на эту цель (как в боте)
    const goalsWithSaved = goals.map(g => {
      const target = parseFloat(g.future_value) || parseFloat(g.target_amount) || 0;
      const saved = goalSaved(g, contributions);
      const percent = target > 0 ? Math.min(100, Math.round((saved / target) * 100)) : 0;
      return {
        id: g.id,
        name: g.name,
        target_amount: target,
        saved,
        percent,
        deadline: g.target_date ?? null,
      };
    });

    res.json({
      user: {
        id: user.id,
        name: user.web_username || user.tg_username || user.email || 'Пользователь',
        subscription_status: sub?.status ?? null,
        subscription_end: sub?.ends_at ?? null,
      },
      no_records: (txTotal ?? 0) === 0,
      balance: { income, expenses, total: income - expenses },
      goals: goalsWithSaved,
      top_categories,
      recent_transactions,
    });
  } catch (err) {
    console.error('[cabinet] /api/dashboard error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────
// GET /api/history?offset=0
// ──────────────────────────────────────────
router.get('/api/history', requireAuth, async (req, res) => {
  try {
    const limit = 50;
    const offset = parseInt(req.query.offset) || 0;

    const { data, error, count } = await supabase
      .from('transactions')
      .select(
        'id, transaction_date, type, amount, comment, raw_message, categories(name)',
        { count: 'exact' }
      )
      .eq('user_id', req.userId)
      .order('transaction_date', { ascending: false })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    res.json({
      data: (data || []).map(t => ({
        id: t.id,
        transaction_date: t.transaction_date,
        type: t.type,
        amount: t.amount,
        comment: displayMessage(t, t.categories?.name),
        category: t.categories?.name || 'Другое',
      })),
      total: count,
      limit,
      offset,
    });
  } catch (err) {
    console.error('[cabinet] /api/history error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────
// PUT /api/history/:id
// ──────────────────────────────────────────
router.put('/api/history/:id', requireAuth, async (req, res) => {
  try {
    const r = await updateTransaction(supabase, req.userId, req.params.id, req.body, await getUserAccess(req.userId));
    res.status(r.status).json(r.json);
  } catch (err) {
    console.error('[cabinet] PUT /api/history/:id error:', err.message);
    res.status(500).json({ error: 'Internal server error', message: 'Не удалось сохранить запись. Попробуй ещё раз' });
  }
});

// ──────────────────────────────────────────
// DELETE /api/history/:id
// ──────────────────────────────────────────
router.delete('/api/history/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from('transactions')
      .delete()
      .eq('id', id)
      .eq('user_id', req.userId);

    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[cabinet] DELETE /api/history/:id error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────
// GET /api/accounting
// ──────────────────────────────────────────
router.get('/api/accounting', requireAuth, async (req, res) => {
  try {
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('created_at')
      .eq('id', req.userId)
      .single();

    if (userError || !user) return res.status(404).json({ error: 'User not found' });

    const { data: transactions, error: txError } = await supabase
      .from('transactions')
      .select('transaction_date, type, amount, categories(name)')
      .eq('user_id', req.userId)
      .order('transaction_date', { ascending: true });

    if (txError) throw txError;

    res.json({
      user_created_at: user.created_at,
      transactions: (transactions || []).map(t => ({
        transaction_date: t.transaction_date,
        type: t.type,
        amount: t.amount,
        category: t.categories?.name || 'Другое',
      })),
    });
  } catch (err) {
    console.error('[cabinet] /api/accounting error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────
// GET /api/categories
// Returns system categories + user's own categories
// ──────────────────────────────────────────
router.get('/api/categories', requireAuth, async (req, res) => {
  try {
    const now = new Date().toISOString();
    const [sysRes, userRes, subRes] = await Promise.all([
      supabase
        .from('categories')
        .select('id, name, type, user_id, group_id, icon, synonyms, is_active, category_groups(name)')
        .is('user_id', null)
        .eq('is_active', true)
        .order('user_id', { nullsFirst: true })
        .order('name', { ascending: true }),
      supabase
        .from('categories')
        .select('id, name, type, user_id, group_id, icon, synonyms, is_active, category_groups(name)')
        .eq('user_id', req.userId)
        .eq('is_active', true)
        .order('user_id', { nullsFirst: true })
        .order('name', { ascending: true }),
      supabase
        .from('subscriptions')
        .select('status')
        .eq('user_id', req.userId)
        .in('status', ['trial', 'active'])
        .gt('ends_at', now)
        .order('ends_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    if (sysRes.error) throw sysRes.error;
    if (userRes.error) throw userRes.error;

    const map = mapCategoryRow;

    const data = [...(userRes.data || []).map(map), ...(sysRes.data || []).map(map)];
    res.json({ data, subscription_status: subRes.data?.status ?? null });
  } catch (err) {
    console.error('[cabinet] GET /api/categories error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────
// POST /api/categories
// Create a new user category
// ──────────────────────────────────────────
router.post('/api/categories', requireAuth, async (req, res) => {
  try {
    const r = await createUserCategory(supabase, req.userId, req.body, await getUserAccess(req.userId));
    res.status(r.status).json(r.json);
  } catch (err) {
    console.error('[cabinet] POST /api/categories error:', err.message);
    res.status(500).json({ error: 'Internal server error', message: 'Не удалось сохранить категорию. Попробуй ещё раз' });
  }
});

// ──────────────────────────────────────────
// GET /api/category-groups
// Группы категорий (для выбора группы в окне «Добавить категорию»)
// ──────────────────────────────────────────
router.get('/api/category-groups', requireAuth, async (req, res) => {
  try {
    const groups = await listGroups(supabase);
    res.json({ data: groups.map((g) => ({ id: g.id, name: g.name, type: g.type })) });
  } catch (err) {
    console.error('[cabinet] GET /api/category-groups error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────
// PUT /api/categories/:id
// Update user's own category (name, type, group, icon, hint)
// ──────────────────────────────────────────
router.put('/api/categories/:id', requireAuth, async (req, res) => {
  try {
    const r = await updateUserCategory(supabase, req.userId, req.params.id, req.body);
    res.status(r.status).json(r.json);
  } catch (err) {
    console.error('[cabinet] PUT /api/categories/:id error:', err.message);
    res.status(500).json({ error: 'Internal server error', message: 'Не удалось сохранить категорию. Попробуй ещё раз' });
  }
});

// ──────────────────────────────────────────
// DELETE /api/categories/:id
// Soft-delete user's own category (is_active = false)
// ──────────────────────────────────────────
router.delete('/api/categories/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    // Verify it's the user's own category (not system)
    const { data: cat } = await supabase
      .from('categories')
      .select('id, user_id')
      .eq('id', id)
      .eq('user_id', req.userId)
      .single();

    if (!cat) return res.status(404).json({ error: 'Category not found or not owned by user' });

    const { error } = await supabase
      .from('categories')
      .update({ is_active: false })
      .eq('id', id)
      .eq('user_id', req.userId);

    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[cabinet] DELETE /api/categories/:id error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/api/feedback', requireAuth, limitFeedback, async (req, res) => {
  try {
    const { email, subject, message } = req.body;
    if (!email || !message) {
      return res.status(400).json({ error: 'Email and message are required' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email' });
    }
    if (message.length > 5000) {
      return res.status(400).json({ error: 'Message too long' });
    }
    if (subject && subject.length > 200) {
      return res.status(400).json({ error: 'Subject too long' });
    }
    const fullMessage = `От: ${email}\nТема: ${subject || '—'}\n\n${message}`;
    const { error } = await supabase.from('feedback').insert({
      user_id: req.userId,
      message: fullMessage,
      status: 'new',
    });
    if (error) throw error;
    notifyAdminAboutFeedback({ source: 'web', from: email, text: fullMessage }).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    console.error('[cabinet] POST /api/feedback error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────
// GET /api/profile
// ──────────────────────────────────────────
router.get('/api/profile', requireAuth, async (req, res) => {
  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('id, external_id, channel, created_at, tg_username, web_username, email, status, password_hash')
      .eq('id', req.userId)
      .single();
    if (error || !user) return res.status(404).json({ error: 'User not found' });

    const { data: subs } = await supabase
      .from('subscriptions')
      .select('status, starts_at, ends_at, period_months, payment_id')
      .eq('user_id', req.userId)
      .order('ends_at', { ascending: false });

    const now = new Date();
    const activeSub = (subs || []).find(s =>
      (s.status === 'trial' || s.status === 'active') && new Date(s.ends_at) > now
    );
    const hadTrialBefore = rowsHadTrial(subs);
    const lastExpiredSub = !activeSub ? (subs || [])[0] : null;

    res.json({
      id: user.id,
      external_id: user.external_id,
      channel: user.channel,
      created_at: user.created_at,
      tg_username: user.tg_username,
      web_username: user.web_username,
      email: user.email,
      username: user.web_username || user.tg_username || user.email || null,
      telegram_connected: user.channel === 'telegram',
      // Telegram можно отключить только если остаётся вход по почте и паролю
      can_disconnect_telegram: !!user.password_hash,
      bot_username: botUsername(),
      subscription: activeSub || null,
      last_subscription: lastExpiredSub,
      had_trial_before: hadTrialBefore,
    });
  } catch (err) {
    console.error('[cabinet] /api/profile error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────
// PUT /api/profile
// ──────────────────────────────────────────
router.put('/api/profile', requireAuth, async (req, res) => {
  try {
    const { web_username, email } = req.body;
    const update = {};
    if (web_username !== undefined) update.web_username = web_username?.trim() || null;
    if (email !== undefined) {
      const trimmedEmail = email?.trim().toLowerCase() || null;
      if (trimmedEmail) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(trimmedEmail)) {
          return res.status(400).json({ error: 'Invalid email format' });
        }
        // Среди аккаунтов с входом по паролю e-mail уникален
        const { data: me } = await supabase
          .from('users')
          .select('id, status, password_hash')
          .eq('id', req.userId)
          .maybeSingle();
        if (isWebAccount(me)) {
          const { data: sameEmail } = await supabase
            .from('users')
            .select('id, status, password_hash')
            .eq('email', trimmedEmail)
            .neq('id', req.userId);
          if ((sameEmail ?? []).some(isWebAccount)) {
            return res.status(409).json({ error: 'email_taken', message: 'Этот e-mail уже используется' });
          }
        }
      }
      update.email = trimmedEmail;
    }
    const { error } = await supabase
      .from('users')
      .update(update)
      .eq('id', req.userId);
    if (error?.code === '23505') return res.status(409).json({ error: 'email_taken', message: 'Этот e-mail уже используется' });
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[cabinet] PUT /api/profile error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────
// POST /api/profile/activate-trial
// ──────────────────────────────────────────
router.post('/api/profile/activate-trial', requireAuth, async (req, res) => {
  try {
    // Доступ уже есть (триал или подписка)
    if ((await getUserAccess(req.userId)) !== 'free') {
      return res.status(400).json({ error: 'Access already active' });
    }
    // Пробный период был и закончился: повторно не включаем
    if (await hadTrial(supabase, req.userId)) {
      return res.status(400).json({ error: 'Trial already used' });
    }
    const trial = await startTrial(supabase, req.userId, { onlyIfNoSubscriptions: false });
    if (!trial.ok) throw new Error('trial start failed: ' + trial.reason);
    res.json({ ok: true });
  } catch (err) {
    console.error('[cabinet] activate-trial error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────
// POST /api/profile/disconnect-telegram
// ──────────────────────────────────────────
router.post('/api/profile/disconnect-telegram', requireAuth, async (req, res) => {
  try {
    const r = await disconnectTelegram(supabase, req.userId);
    if (r.ok) return res.json({ ok: true });
    if (r.reason === 'no_login') {
      return res.status(409).json({
        error: 'no_login',
        message: 'Отключить Telegram нельзя: у этого аккаунта нет входа по почте и паролю, и ты потеряешь доступ. Сначала зарегистрируйся на сайте через почту.',
      });
    }
    if (r.reason === 'no_user') return res.status(404).json({ error: 'User not found' });
    throw new Error(r.reason);
  } catch (err) {
    console.error('[cabinet] disconnect-telegram error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────
// POST /api/profile/telegram-link
// Создаёт одноразовую ссылку (15 минут) для подключения Telegram к этому аккаунту.
// В боте человек нажимает «Старт» и подтверждает; если в боте уже были данные, они переносятся сюда.
// ──────────────────────────────────────────
router.post('/api/profile/telegram-link', requireAuth, limitTelegramLink, async (req, res) => {
  try {
    const r = await createLinkToken(supabase, req.userId);
    if (r.ok) return res.json({ url: botLinkUrl(r.token), expires_in: Math.round(LINK_TTL_MS / 1000) });
    if (r.reason === 'already_connected') return res.status(409).json({ error: 'already_connected', message: 'Telegram уже подключён' });
    if (r.reason === 'no_user') return res.status(404).json({ error: 'User not found' });
    throw new Error(r.reason);
  } catch (err) {
    console.error('[cabinet] telegram-link error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────
// DELETE /api/profile
// ──────────────────────────────────────────
router.delete('/api/profile', requireAuth, async (req, res) => {
  try {
    const { error } = await supabase
      .from('users')
      .update({ status: 'deleted', deleted_at: new Date().toISOString() })
      .eq('id', req.userId);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[cabinet] DELETE /api/profile error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────
// POST /api/bot/init
// Инициализация веб-чата. Вызывается при первом открытии чата в ЛК.
// Показывает главное меню. Пользователь уже аутентифицирован через JWT,
// поэтому handleStart не используется — только showMainMenu напрямую.
// ──────────────────────────────────────────
router.post('/api/bot/init', requireAuth, async (req, res) => {
  try {
    const chatId = await getOrCreateWebChatId(req.userId);
    clearWebChatQueue(chatId);

    // Убеждаемся что terms_accepted_at проставлен —
    // JWT-аутентификация означает что пользователь уже прошёл регистрацию.
    // Это позволяет requireTerms пропускать сообщения веб-чата.
    await supabase
      .from('users')
      .update({ terms_accepted_at: new Date().toISOString() })
      .eq('id', req.userId)
      .is('terms_accepted_at', null);

    const welcomed = await maybeShowWebWelcome(webBot, chatId, req.userId);
    if (!welcomed) await showMainMenu(webBot, chatId);

    const queue = getWebChatQueue(chatId);
    const messages = queue.splice(0, queue.length);
    res.json({ ok: true, chatId, messages });
  } catch (err) {
    console.error('[cabinet] /api/bot/init error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────
// POST /api/bot/send
// Пользователь отправляет сообщение в веб-чат.
// ──────────────────────────────────────────
router.post('/api/bot/send', requireAuth, limitChatSend, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'Empty message' });

    const chatId = await getOrCreateWebChatId(req.userId);

    const fakeMsg = {
      message_id: Date.now(),
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId },
      from: { id: chatId, username: null, first_name: null },
      text: text.trim(),
    };

    // Запускаем обработку асинхронно — ответ придёт через /api/bot/poll
    handleMessage(webBot, fakeMsg).catch(err => {
      console.error('[webchat] handleMessage error:', err.message);
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[cabinet] /api/bot/send error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────
// GET /api/bot/poll
// Long-polling: ждёт новые сообщения от бота до 25 секунд.
// ──────────────────────────────────────────
router.get('/api/bot/poll', requireAuth, async (req, res) => {
  try {
    const chatId = await getOrCreateWebChatId(req.userId);
    const queue = getWebChatQueue(chatId);

    if (queue.length > 0) {
      const messages = queue.splice(0, queue.length);
      return res.json({ messages });
    }

    const got = await waitForNewMessage(chatId, 25000);
    if (got) {
      const messages = queue.splice(0, queue.length);
      return res.json({ messages });
    }
    res.json({ messages: [] });
  } catch (err) {
    console.error('[cabinet] /api/bot/poll error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────
// POST /api/bot/callback
// Обрабатывает нажатие inline-кнопки из веб-чата.
// ──────────────────────────────────────────
router.post('/api/bot/callback', requireAuth, async (req, res) => {
  try {
    const { callback_data } = req.body;
    if (!callback_data) return res.status(400).json({ error: 'Missing callback_data' });

    const chatId = await getOrCreateWebChatId(req.userId);
    clearWebChatQueue(chatId);

    const fakeQuery = {
      id: String(Date.now()),
      data: callback_data,
      from: { id: chatId, username: null, first_name: null },
      message: {
        message_id: Date.now(),
        chat: { id: chatId },
        date: Math.floor(Date.now() / 1000),
        text: '',
      },
    };

    await dispatchCallbackQuery(webBot, fakeQuery);

    const queue = getWebChatQueue(chatId);
    const messages = queue.splice(0, queue.length);
    res.json({ ok: true, messages });
  } catch (err) {
    console.error('[cabinet] /api/bot/callback error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;

