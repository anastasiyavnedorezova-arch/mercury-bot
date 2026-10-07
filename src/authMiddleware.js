import jwt from 'jsonwebtoken';

export function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    // Токены, выданные 07.10.2026 первой версией нового входа, содержат id в поле sub.
    // Принимаем их, пока не истекут (30 дней), иначе у вошедших в этот час кабинет остаётся пустым.
    req.userId = payload.userId ?? payload.sub;
    if (!req.userId) return res.status(401).json({ error: 'Invalid token' });
    req.telegramId = payload.telegramId;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}
