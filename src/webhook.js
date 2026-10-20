import express from 'express';
import { supabase } from './db.js';
import path from 'path';
import { fileURLToPath } from 'url';
import cabinetRoutes from './cabinetRoutes.js';
import authRoutes from './authRoutes.js';
import { grantSubscription } from './utils/grantSubscription.js';
import { createEmailRouter } from './emails/unsubscribe.js';
import { createRusenderRouter } from './emails/events.js';
import { createPaymentRouter } from './payments/routes.js';
import { processYookassaEvent } from './payments/process.js';
import { fetchPayment } from './payments/yookassa.js';
import { sendLetter } from './emails/send.js';
import { maySendTo } from './emails/config.js';
import { addSeoRoutes } from './seo.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function monthsWord(n) {
  if (n === 1) return 'месяц';
  if (n >= 2 && n <= 4) return 'месяца';
  return 'месяцев';
}

export function startWebhookServer(bot) {
  const app = express();
  // За прокси (nginx): настоящий IP клиента нужен для ограничения попыток входа
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use((req, res, next) => {
    if (req.path.startsWith('/cabinet')) {
      res.setHeader('Content-Security-Policy',
        "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://telegram.org; frame-src https://oauth.telegram.org; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self'"
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
  // robots.txt, sitemap.xml, noindex для stage — до всех страниц
  addSeoRoutes(app);
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
  app.get('/cabinet/profile.html',     (req, res) => res.redirect(301, '/cabinet/profile'));
  app.get('/cabinet/analytics.html',   (req, res) => res.redirect(301, '/cabinet/analytics'));
  app.get('/cabinet/family.html',      (req, res) => res.redirect(301, '/cabinet/family'));
  app.get('/cabinet/bot.html',         (req, res) => res.redirect(301, '/cabinet/bot'));
  app.get('/cabinet/reset-password.html', (req, res) => res.redirect(301, '/cabinet/reset-password'));
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
  app.get('/cabinet/profile',    (req, res) => res.sendFile(path.join(__dirname, '../public/cabinet/profile.html')));
  app.get('/cabinet/analytics',  (req, res) => res.sendFile(path.join(__dirname, '../public/cabinet/analytics.html')));
  app.get('/cabinet/family',     (req, res) => res.sendFile(path.join(__dirname, '../public/cabinet/family.html')));
  app.get('/cabinet/bot',            (req, res) => res.sendFile(path.join(__dirname, '../public/cabinet/bot.html')));
  app.get('/cabinet/reset-password', (req, res) => res.sendFile(path.join(__dirname, '../public/cabinet/reset-password.html')));
  app.get('/cabinet',                (req, res) => res.redirect(301, '/cabinet/dashboard'));
  for (const doc of ['offer', 'privacy', 'consent', 'cookies']) {
    app.get(`/legal/${doc}`, (req, res) => res.sendFile(path.join(__dirname, `../public/legal/${doc}.html`)));
  }

  app.use('/fonts', express.static(path.join(__dirname, '../public/fonts'), { maxAge: '365d', immutable: true }));
  app.use(express.static(path.join(__dirname, '../public')));
  app.use(createEmailRouter({ db: supabase }));
  app.use(createRusenderRouter({ db: supabase }));
  app.use(createPaymentRouter({ db: supabase }));
  app.use(authRoutes);
  app.use(cabinetRoutes);

  app.get('/', (req, res) => {
    res.send('Finnik bot webhook server is running');
  });

  // ЮKassa: уведомление «платёж прошёл». Платёж перепроверяется запросом в ЮKassa (см. payments/process.js).
  app.post('/webhook/yookassa', async (req, res) => {
    try {
      const event = req.body;
      console.log('[webhook] yookassa:', event?.event, event?.object?.id);
      const out = await processYookassaEvent(supabase, event, {
        fetchPayment,
        grant: grantSubscription,
        onGranted: async ({ user, months, endsAt, payment, amount }) => {
          console.log('[webhook] Subscription created for user:', user.id, 'payment:', payment.id, 'months:', months);
          if (user.channel === 'telegram' && user.external_id) {
            await bot.sendMessage(
              user.external_id,
              '🎉 Подписка активирована!\n\n' +
              `✅ Период: ${months} ${monthsWord(months)}\n` +
              `📅 Действует до: ${endsAt.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' })}\n\n` +
              'Теперь тебе доступны все функции Финника 💛',
              { reply_markup: { inline_keyboard: [[{ text: '☰ Главное меню', callback_data: 'menu:main' }]] } }
            ).catch((e) => console.error('[webhook] notify error:', e.message));
          }
          if (user.email && maySendTo(user.email)) {
            sendLetter(supabase, user.id, 'sub_started', { vars: { endsAt }, logKey: `sub_started:${payment.id}` }).catch((e) => console.error('[webhook] letter error:', e.message));
          }
        },
        onUnmatched: async ({ payment, amount, months }) => {
          console.error('[webhook] User not found for payment:', payment.id);
          const email = payment.receipt?.customer?.email ?? payment.metadata?.custEmail ?? null;
          await supabase.from('feedback').insert({
            message: `НЕОБРАБОТАННЫЙ ПЛАТЁЖ: paymentId=${payment.id}, amount=${amount}, email=${email}`,
          }).catch((e) => console.error('[webhook] feedback insert error:', e.message));
          if (process.env.ADMIN_TELEGRAM_ID) {
            await bot.sendMessage(
              process.env.ADMIN_TELEGRAM_ID,
              `⚠️ Необработанный платёж!\nPaymentId: ${payment.id}\nСумма: ${amount} ₽\nEmail: ${email}\n\n` +
              `Активируй вручную: /activate <telegram_id> ${months}`
            ).catch((e) => console.error('[webhook] admin notify error:', e.message));
          }
        },
      });
      console.log('[webhook] yookassa result:', out.result);
      res.status(out.status).send(out.status === 200 ? 'ok' : 'error');
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
