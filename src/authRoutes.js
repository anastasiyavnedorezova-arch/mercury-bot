import { supabase } from './db.js';
import { sendWelcomeEmail, sendPasswordResetEmail } from './utils/email.js';
import { createRateLimiter } from './auth/rateLimit.js';
import { createAuthRouter } from './auth/authRouter.js';

const limits = {
  ipRegister:    createRateLimiter({ windowMs: 60 * 60 * 1000, max: 10 }),
  emailRegister: createRateLimiter({ windowMs: 60 * 60 * 1000, max: 5 }),
  ipLogin:       createRateLimiter({ windowMs: 15 * 60 * 1000, max: 20 }),
  emailLogin:    createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10 }),
  ipForgot:      createRateLimiter({ windowMs: 60 * 60 * 1000, max: 10 }),
  emailForgot:   createRateLimiter({ windowMs: 60 * 60 * 1000, max: 3 }),
};

const authRoutes = createAuthRouter({
  db: supabase,
  mailer: { sendWelcomeEmail, sendPasswordResetEmail },
  limits,
  getBaseUrl: () => process.env.APP_BASE_URL ?? 'https://finnik.ru',
  getJwtSecret: () => process.env.JWT_SECRET,
});

export default authRoutes;
