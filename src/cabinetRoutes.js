import { Router } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { supabase } from './db.js';
import { requireAuth } from './authMiddleware.js';

const router = Router();

// ──────────────────────────────────────────
// POST /auth/telegram
// Принимает данные Telegram Login Widget,
// проверяет HMAC-SHA256, возвращает JWT.
// ──────────────────────────────────────────
router.post('/auth/telegram', async (req, res) => {
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
      .update(process.env.BOT_TOKEN)
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

    // Ищем или создаём пользователя
    let { data: users, error } = await supabase
      .from('users')
      .select('id, external_id, channel')
      .eq('external_id', telegramId)
      .limit(1);

    if (error) throw error;

    let userId;

    if (users?.length) {
      userId = users[0].id;
    } else {
      // Создаём нового пользователя (без подписки)
      const { data: created, error: createErr } = await supabase
        .from('users')
        .insert({ external_id: telegramId, channel: 'telegram' })
        .select('id')
        .single();

      if (createErr) throw createErr;
      userId = created.id;
    }

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
        'id, type, amount, description, transaction_date, categories(name, category_groups(name))',
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
      .select('*, categories(name, category_groups(name))')
      .eq('user_id', req.userId)
      .eq('month', monthDate);

    if (error) throw error;
    res.json({ data, month: monthDate });
  } catch (err) {
    console.error('[cabinet] /api/budget error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
