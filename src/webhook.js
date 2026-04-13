import express from 'express';
import { supabase } from './db.js';

function monthsWord(n) {
  if (n === 1) return 'месяц';
  if (n >= 2 && n <= 4) return 'месяца';
  return 'месяцев';
}

export function startWebhookServer(bot) {
  const app = express();
  app.use(express.json());

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
      const { data: existing } = await supabase
        .from('subscriptions')
        .select('id')
        .eq('payment_id', paymentId)
        .limit(1);

      if (existing?.length) {
        console.log('[webhook] Payment already processed:', paymentId);
        return res.status(200).send('ok');
      }

      // Ищем пользователя по email
      const { data: users } = await supabase
        .from('users')
        .select('id, external_id')
        .eq('email', customerEmail)
        .limit(1);

      if (!users?.length) {
        console.error('[webhook] User not found for email:', customerEmail);

        // Сохраняем необработанный платёж для ручной активации
        await supabase.from('feedback').insert({
          message: `НЕОБРАБОТАННЫЙ ПЛАТЁЖ: paymentId=${paymentId}, amount=${amount}, email=${customerEmail}`,
        }).catch(e => console.error('[webhook] feedback insert error:', e.message));

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

      const { id: userId, external_id: telegramId } = users[0];

      const startsAt = new Date();
      const endsAt = new Date();
      endsAt.setMonth(endsAt.getMonth() + months);

      await supabase.from('subscriptions').insert({
        user_id: userId,
        status: 'active',
        period_months: months,
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
        payment_id: paymentId,
        amount_rub: Math.round(amount),
      });

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
