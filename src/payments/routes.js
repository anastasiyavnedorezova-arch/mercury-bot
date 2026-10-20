// POST /api/pay { months: 1 | 6 | 12, email?, promo? } → { url } — ссылка на оплату ЮKassa для вошедшего пользователя.
// POST /api/promo/check { code } → { code, amount_off_rub } — проверка промокода до оплаты (показать новую цену).
// Чек уходит на email из профиля. Если в профиле его нет (например, вход через Telegram), берём email из запроса
// и пробуем сохранить его в профиль (если он занят другим аккаунтом, сохранение пропускаем: для чека это не важно).
import { Router } from 'express';
import { requireAuth as requireJwt, requireActiveAccount } from '../authMiddleware.js';
import { baseUrl } from '../emails/config.js';
import { createPayment, isPlanMonths } from './yookassa.js';
import { checkPromo, normalizeCode, priceWithPromo, tooManyChecks, PROMO_MESSAGES } from './promo.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ERRORS = {
  bad_months: [400, 'Неизвестный тариф.'],
  no_email: [400, 'Чтобы оплатить, нужен email: на него придёт чек.'],
  bad_email: [400, 'Введи корректный email, например ivan@gmail.com'],
  not_configured: [503, 'Оплата временно недоступна. Попробуй позже.'],
  yookassa_error: [502, 'Не удалось создать платёж. Попробуй ещё раз.'],
};

export function createPaymentRouter({ db, create = createPayment }) {
  const router = Router();
  const requireAuth = [requireJwt, requireActiveAccount(db)];

  router.post('/api/promo/check', requireAuth, async (req, res) => {
    try {
      if (tooManyChecks(req.userId)) return res.status(429).json({ error: 'too_many', message: 'Слишком много попыток. Подожди минуту.' });
      const r = await checkPromo(db, req.body?.code, req.userId);
      if (!r.ok) return res.status(400).json({ error: `promo_${r.reason}`, message: PROMO_MESSAGES[r.reason] });
      res.json({ code: r.promo.code, amount_off_rub: r.promo.amountOff });
    } catch (e) {
      console.error('[promo] check error:', e.message);
      res.status(500).json({ error: 'internal', message: 'Не удалось проверить промокод. Попробуй ещё раз.' });
    }
  });

  router.post('/api/pay', requireAuth, async (req, res) => {
    try {
      const months = Number(req.body?.months);
      if (!isPlanMonths(months)) return res.status(400).json({ error: 'bad_months', message: ERRORS.bad_months[1] });

      const { data: user } = await db.from('users').select('id, email').eq('id', req.userId).maybeSingle();
      if (!user) return res.status(401).json({ error: 'Unauthorized' });

      let email = user.email ? String(user.email).trim() : '';
      if (!email) {
        const given = req.body?.email === undefined || req.body?.email === null ? '' : String(req.body.email).trim().toLowerCase();
        if (!given) return res.status(400).json({ error: 'no_email', message: ERRORS.no_email[1] });
        if (!EMAIL_RE.test(given) || given.length > 254) return res.status(400).json({ error: 'bad_email', message: ERRORS.bad_email[1] });
        email = given;
        try {
          const { error: saveError } = await db.from('users').update({ email }).eq('id', user.id);
          if (saveError) console.log('[pay] email not saved to profile:', saveError.code || saveError.message);
        } catch (e) {
          console.log('[pay] email not saved to profile:', e.message);
        }
      }

      let promo = null;
      if (normalizeCode(req.body?.promo)) {
        if (tooManyChecks(user.id)) return res.status(429).json({ error: 'too_many', message: 'Слишком много попыток. Подожди минуту.' });
        const pr = await checkPromo(db, req.body.promo, user.id);
        if (!pr.ok) return res.status(400).json({ error: `promo_${pr.reason}`, message: PROMO_MESSAGES[pr.reason] });
        if (priceWithPromo(months, pr.promo.amountOff) === null) return res.status(400).json({ error: 'promo_not_applicable', message: PROMO_MESSAGES.not_applicable });
        promo = pr.promo;
      }

      const r = await create({
        months,
        userId: user.id,
        email,
        returnUrl: `${baseUrl()}/cabinet/profile?paid=1`,
        ...(promo ? { promo } : {}),
      });
      if (!r.ok) {
        if (r.reason === 'promo_not_applicable') return res.status(400).json({ error: r.reason, message: PROMO_MESSAGES.not_applicable });
        const [status, message] = ERRORS[r.reason] ?? ERRORS.yookassa_error;
        return res.status(status).json({ error: r.reason, message });
      }
      console.log(`[pay] payment ${r.id} created, user=${user.id}, months=${months}${promo ? `, promo=${promo.code}` : ''}`);
      res.json({ url: r.url });
    } catch (e) {
      console.error('[pay] error:', e.message);
      res.status(500).json({ error: 'internal', message: 'Не удалось создать платёж. Попробуй ещё раз.' });
    }
  });
  return router;
}
