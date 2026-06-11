import express from 'express';
import { supabase } from './db.js';
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
    if (req.path.startsWith('/cabinet')) {
      res.setHeader('Content-Security-Policy',
        "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://telegram.org; frame-src https://oauth.telegram.org; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self' https://api.supabase.co https://*.supabase.co"
      );
    }
    next();
  });
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] !== 'https') {
      return res.redirect(301, 'https://' + req.headers.host + req.url);
    }
    next();
  });
  // ── Clean URL redirects (no .html) ──────────────────────────────────────
  // .html → clean
  app.get('/cabinet/login.html',     (req, res) => res.redirect(301, '/cabinet/login'));
  app.get('/cabinet/dashboard.html', (req, res) => res.redirect(301, '/cabinet/dashboard'));
  app.get('/cabinet/register.html',    (req, res) => res.redirect(301, '/cabinet/register'));
  app.get('/cabinet/accounting.html',  (req, res) => res.redirect(301, '/cabinet/accounting'));
  app.get('/cabinet/history.html',     (req, res) => res.redirect(301, '/cabinet/history'));
  app.get('/cabinet/categories.html',  (req, res) => res.redirect(301, '/cabinet/categories'));
  app.get('/cabinet/how-to.html',      (req, res) => res.redirect(301, '/cabinet/how-to'));
  app.get('/cabinet/goals.html',       (req, res) => res.redirect(301, '/cabinet/goals'));
  app.get('/cabinet/budget.html',      (req, res) => res.redirect(301, '/cabinet/budget'));
  app.get('/cabinet/feedback.html',    (req, res) => res.redirect(301, '/cabinet/feedback'));
  app.get('/cabinet/faq.html',         (req, res) => res.redirect(301, '/cabinet/faq'));
  // clean → file
  app.get('/cabinet/login',       (req, res) => res.sendFile(path.join(__dirname, '../public/cabinet/login.html')));
  app.get('/cabinet/dashboard',   (req, res) => res.sendFile(path.join(__dirname, '../public/cabinet/dashboard.html')));
  app.get('/cabinet/register',    (req, res) => res.sendFile(path.join(__dirname, '../public/cabinet/register.html')));
  app.get('/cabinet/accounting',  (req, res) => res.sendFile(path.join(__dirname, '../public/cabinet/accounting.html')));
  app.get('/cabinet/history',     (req, res) => res.sendFile(path.join(__dirname, '../public/cabinet/history.html')));
  app.get('/cabinet/categories', (req, res) => res.sendFile(path.join(__dirname, '../public/cabinet/categories.html')));
  app.get('/cabinet/how-to',     (req, res) => res.sendFile(path.join(__dirname, '../public/cabinet/how-to.html')));
  app.get('/cabinet/goals',      (req, res) => res.sendFile(path.join(__dirname, '../public/cabinet/goals.html')));
  app.get('/cabinet/budget',     (req, res) => res.sendFile(path.join(__dirname, '../public/cabinet/budget.html')));
  app.get('/cabinet/feedback',   (req, res) => res.sendFile(path.join(__dirname, '../public/cabinet/feedback.html')));
  app.get('/cabinet/faq',        (req, res) => res.sendFile(path.join(__dirname, '../public/cabinet/faq.html')));
  app.get('/cabinet',           (req, res) => res.redirect(301, '/cabinet/dashboard'));

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
