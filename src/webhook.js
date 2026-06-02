import express from 'express';
import { queryOne, run } from './db.js';
import path from 'path';
import { fileURLToPath } from 'url';
import cabinetRoutes from './cabinetRoutes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function monthsWord(n) {
  if (n === 1) return 'месяц';
  if (n >= 2 && n <= 4) return 'месяца';
  return 'месяцев';
}

export function startWebhookServer(bot) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] !== 'https') {
      return res.redirect(301, 'https://' + req.headers.host + req.url);
    }
    next();
  });
  app.use(express.static(path.join(__dirname, '../public')));
  app.use(cabinetRoutes);

  app.get('/', (req, res) => {
    res.send('Mercury bot webhook server is running');
  });

  app.post('/webhook/yookassa', async (req, res) => {
    try {
      const event = req.body;
      console.log('[webhook] Received:', JSON.stringify(event));

      if (event.event !== 'payment.succeeded') {
        return res.status(200).send('ok');
      }

      const payment = event.object;
      const amount = parseFloat(payment.amount.value);
      const paymentId = payment.id;

      // Email покупателя — ЮKassa передаёт в receipt или metadata
      const customerEmail =
        payment.receipt?.customer?.email ??
        payment.metadata?.custEmail ??
        payment.metadata?.customerNumber ??
        null;

      let months = 1;
      if (amount >= 4490) months = 12;
      else if (amount >= 2490) months = 6;

      console.log('[webhook] Payment succeeded:', paymentId,
        'amount:', amount, 'email:', customerEmail, 'months:', months);

      // Идемпотентность — не обрабатывать один платёж дважды
      const { data: existing } = await queryOne(
        `SELECT id FROM subscriptions WHERE payment_id = $1 LIMIT 1`,
        [paymentId]
      );

      if (existing) {
        console.log('[webhook] Payment already processed:', paymentId);
        return res.status(200).send('ok');
      }

      // Ищем пользователя по email
      const { data: userRow } = await queryOne(
        `SELECT id, external_id FROM users WHERE email = $1 LIMIT 1`,
        [customerEmail]
      );

      if (!userRow) {
        console.error('[webhook] User not found for email:', customerEmail);

        // Сохраняем необработанный платёж для ручной активации
        await run(
          `INSERT INTO feedback (message) VALUES ($1)`,
          [`НЕОБРАБОТАННЫЙ ПЛАТЁЖ: paymentId=${paymentId}, amount=${amount}, email=${customerEmail}`]
        ).catch(e => console.error('[webhook] feedback insert error:', e.message));

        // Уведомляем администратора
        await bot.sendMessage(
          process.env.ADMIN_TELEGRAM_ID,
          `⚠️ Необработанный платёж!\n` +
          `PaymentId: ${paymentId}\n` +
          `Сумма: ${amount} ₽\n` +
          `Email: ${customerEmail}\n\n` +
          `Активируй вручную: /activate <telegram_id> ${months}`
        ).catch(e => console.error('[webhook] admin notify error:', e.message));

        return res.status(200).send('ok');
      }

      const { id: userId, external_id: telegramId } = userRow;

      const startsAt = new Date();
      const endsAt = new Date();
      endsAt.setMonth(endsAt.getMonth() + months);

      await run(
        `INSERT INTO subscriptions (user_id, status, period_months, starts_at, ends_at, payment_id, amount_rub)
         VALUES ($1, 'active', $2, $3, $4, $5, $6)`,
        [userId, months, startsAt.toISOString(), endsAt.toISOString(), paymentId, Math.round(amount)]
      );

      console.log('[webhook] Subscription created for user:', userId);

      await bot.sendMessage(
        telegramId,
        '🎉 Подписка активирована!\n\n' +
        `✅ Период: ${months} ${monthsWord(months)}\n` +
        `📅 Действует до: ${endsAt.toLocaleDateString('ru-RU')}\n\n` +
        'Теперь тебе доступны все функции Меркури 💛',
        {
          reply_markup: {
            inline_keyboard: [[
              { text: '☰ Главное меню', callback_data: 'menu:main' },
            ]],
          },
        }
      );

      res.status(200).send('ok');

    } catch (err) {
      console.error('[webhook] Error:', err.message);
      res.status(500).send('error');
    }
  });

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`[webhook] Server listening on port ${PORT}`);
  });
}
