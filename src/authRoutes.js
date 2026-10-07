import { supabase } from './db.js';
import { createAuthRouter } from './auth/authRouter.js';
import { sendWelcomeEmail, sendPasswordResetEmail } from './utils/email.js';

export default createAuthRouter({
  db: supabase,
  mailer: { sendWelcomeEmail, sendPasswordResetEmail },
});
