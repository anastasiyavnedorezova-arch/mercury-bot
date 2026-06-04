import { Router } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { supabase } from './db.js';
import { requireAuth } from './authMiddleware.js';

const router = Router();

// ──────────────────────────────────────────
// POST /api/auth/telegram
// Принимает данные Telegram Login Widget,
// проверяет HMAC-SHA256, возвращает JWT.
// ──────────────────────────────────────────
router.post('/api/auth/telegram', async (req, res) => {
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
      .select('id, external_id, channel')
      .eq('external_id', telegramId)
      .eq('channel', 'telegram')
      .limit(1);

    if (error) throw error;

    if (!users?.length) {
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
      .select('id, external_id, channel, created_at')
      .eq('id', req.userId)
      .single();

    if (error || !user) return res.status(404).json({ error: 'User not found' });

    const { data: sub } = await supabase
      .from('subscriptions')
      .select('status, starts_at, ends_at, period_months')
      .eq('user_id', req.userId)
      .eq('status', 'active')
      .order('ends_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    res.json({ ...user, subscription: sub ?? null });
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
      const from = new Date(year, month - 1, 1).toISOString().slice(0, 10);
      const to = new Date(year, month, 0).toISOString().slice(0, 10);
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
    res.json({ data });
  } catch (err) {
    console.error('[cabinet] /api/goals error:', err.message);
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
      monthDate = new Date(year, month - 1, 1).toISOString().slice(0, 10);
    } else {
      const now = new Date();
      monthDate = new Date(now.getFullYear(), now.getMonth(), 1)
        .toISOString()
        .slice(0, 10);
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
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);

    const [userRes, subRes, txRes, goalsRes] = await Promise.all([
      supabase.from('users').select('id, external_id, username').eq('id', req.userId).single(),
      supabase.from('subscriptions')
        .select('status, ends_at')
        .eq('user_id', req.userId)
        .in('status', ['trial', 'active'])
        .gt('ends_at', now.toISOString())
        .order('ends_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase.from('transactions')
        .select('id, type, amount, comment, transaction_date, categories(name)')
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

    // Находим category_id категории «Цель» (системная, user_id IS NULL)
    let goalCategoryId = null;
    const { data: catData } = await supabase
      .from('categories')
      .select('id')
      .eq('name', 'Цель')
      .is('user_id', null)
      .limit(1)
      .maybeSingle();
    goalCategoryId = catData?.id ?? null;

    // Сумма всех целевых транзакций пользователя
    let totalGoalTx = 0;
    if (goalCategoryId) {
      const { data: goalTxData } = await supabase
        .from('transactions')
        .select('amount')
        .eq('user_id', req.userId)
        .eq('category_id', goalCategoryId);
      totalGoalTx = goalTxData?.reduce((sum, t) => sum + (parseFloat(t.amount) || 0), 0) ?? 0;
    }

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
      comment: t.comment,
      date: t.transaction_date,
      category: t.categories?.name || 'Другое',
    }));

    // Цели: saved = initial_saved + все целевые транзакции (как в боте)
    const goalsWithSaved = goals.map(g => {
      const target = parseFloat(g.future_value) || parseFloat(g.target_amount) || 0;
      const saved = (parseFloat(g.initial_saved) || 0) + totalGoalTx;
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
        name: user.username || user.external_id || 'Пользователь',
        subscription_status: sub?.status ?? null,
        subscription_end: sub?.ends_at ?? null,
      },
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

export default router;
