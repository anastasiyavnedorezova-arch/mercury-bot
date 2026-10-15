// POST /api/pay { months: 1 | 6 | 12 } → { url } — ссылка на оплату ЮKassa для вошедшего пользователя.
import { Router } from 'express';
import { requireAuth } from '../authMiddleware.js';
import { baseUrl } from '../emails/config.js';
import { createPayment, isPlanMonths } from './yookassa.js';

const ERRORS = {
  bad_months: [400, 'Неизвестный тариф.'],
  no_email: [400, 'Чтобы оплатить, укажите e-mail в профиле: на него придёт чек.'],
  not_configured: [503, 'Оплата временно недоступна. Попробуйте позже.'],
  yookassa_error: [502, 'Не удалось создать платёж. Попробуйте ещё раз.'],
};

export function createPaymentRouter({ db, create = createPayment }) {
  const router = Router();
  router.post('/api/pay', requireAuth, async (req, res) => {
    try {
      const months = Number(req.body?.months);
      if (!isPlanMonths(months)) return res.status(400).json({ error: 'bad_months', message: ERRORS.bad_months[1] });

      const { data: user } = await db.from('users').select('id, email').eq('id', req.userId).maybeSingle();
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      const email = user.email ? String(user.email).trim() : '';
      if (!email) return res.status(400).json({ error: 'no_email', message: ERRORS.no_email[1] });

      const r = await create({
        months,
        userId: user.id,
        email,
        returnUrl: `${baseUrl()}/cabinet/profile?paid=1`,
      });
      if (!r.ok) {
        const [status, message] = ERRORS[r.reason] ?? ERRORS.yookassa_error;
        return res.status(status).json({ error: r.reason, message });
      }
      console.log(`[pay] payment ${r.id} created, user=${user.id}, months=${months}`);
      res.json({ url: r.url });
    } catch (e) {
      console.error('[pay] error:', e.message);
      res.status(500).json({ error: 'internal', message: 'Не удалось создать платёж. Попробуйте ещё раз.' });
    }
  });
  return router;
}
