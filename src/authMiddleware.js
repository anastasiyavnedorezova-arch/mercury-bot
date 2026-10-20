import jwt from 'jsonwebtoken';

export function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = payload.userId;
    if (!req.userId) return res.status(401).json({ error: 'Invalid token' });
    req.telegramId = payload.telegramId;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

const INACTIVE = new Set(['deleted', 'merged']);

// Вход по токену не проверяет базу, поэтому токен удалённого или объединённого аккаунта продолжал работать:
// кабинет показывал пустые данные, а веб-чат отвечал «Не нашёл твой аккаунт. Напиши /start». Теперь такой
// сеанс получает 401, и кабинет отправляет человека на страницу входа.
export function requireActiveAccount(db) {
  return async (req, res, next) => {
    try {
      const { data, error } = await db.from('users').select('id, status').eq('id', req.userId).maybeSingle();
      if (error) throw new Error(error.message);
      if (!data || INACTIVE.has(data.status ?? 'active')) {
        return res.status(401).json({ error: 'Account inactive', code: 'account_inactive' });
      }
      return next();
    } catch (e) {
      console.error('[auth] account check failed:', e.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
  };
}
