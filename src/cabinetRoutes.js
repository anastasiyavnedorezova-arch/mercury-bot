import { Router } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { queryOne, queryAll } from './db.js';
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
    let { data: user } = await queryOne(
      `SELECT id FROM users WHERE external_id = $1 AND channel = 'telegram'`,
      [telegramId]
    );

    let userId;

    if (user) {
      userId = user.id;
    } else {
      const { data: created, error: createErr } = await queryOne(
        `INSERT INTO users (external_id, channel) VALUES ($1, 'telegram') RETURNING id`,
        [telegramId]
      );
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
    const { data: user } = await queryOne(
      `SELECT id, external_id, channel, created_at FROM users WHERE id = $1`,
      [req.userId]
    );

    if (!user) return res.status(404).json({ error: 'User not found' });

    const { data: sub } = await queryOne(
      `SELECT status, starts_at, ends_at, period_months FROM subscriptions
       WHERE user_id = $1 AND status = 'active' AND ends_at > NOW()
       ORDER BY ends_at DESC LIMIT 1`,
      [req.userId]
    );

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

    let whereClause = `WHERE t.user_id = $1`;
    const params = [req.userId];

    if (req.query.month) {
      const [year, month] = req.query.month.split('-').map(Number);
      const from = new Date(year, month - 1, 1).toISOString().slice(0, 10);
      const to = new Date(year, month, 0).toISOString().slice(0, 10);
      params.push(from, to);
      whereClause += ` AND t.transaction_date >= $${params.length - 1} AND t.transaction_date <= $${params.length}`;
    }

    const { data: countRow } = await queryOne(
      `SELECT COUNT(*) AS total FROM transactions t ${whereClause}`,
      params
    );
    const total = parseInt(countRow?.total ?? 0);

    params.push(limit, offset);
    const { data: rows } = await queryAll(
      `SELECT t.id, t.type, t.amount, t.comment, t.transaction_date,
              json_build_object('name', c.name,
                'category_groups', json_build_object('name', cg.name)) AS categories
       FROM transactions t
       LEFT JOIN categories c ON t.category_id = c.id
       LEFT JOIN category_groups cg ON c.group_id = cg.id
       ${whereClause}
       ORDER BY t.transaction_date DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({ data: rows ?? [], total, limit, offset });
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
    const { data } = await queryAll(
      `SELECT * FROM goals WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.userId]
    );
    res.json({ data: data ?? [] });
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

    const { data } = await queryAll(
      `SELECT b.*,
              json_build_object('name', c.name,
                'category_groups', json_build_object('name', cg.name)) AS categories
       FROM budget b
       LEFT JOIN categories c ON b.category_id = c.id
       LEFT JOIN category_groups cg ON c.group_id = cg.id
       WHERE b.user_id = $1 AND b.month = $2`,
      [req.userId, monthDate]
    );

    res.json({ data: data ?? [], month: monthDate });
  } catch (err) {
    console.error('[cabinet] /api/budget error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
