import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { login, me, logout, changePassword } from '../controllers/auth.controller.js';
import { auth } from '../middleware/auth.js';
import { skipRateLimit } from '../utils/rateLimit.js';

const router = Router();

// Stricter than the global 100/min limiter — slows credential brute-forcing.
const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipRateLimit,
  message: { message: 'Too many login attempts, please try again later.' },
});

router.post('/login', loginLimiter, login);
router.get('/me', auth, me);
router.post('/logout', auth, logout);
router.post('/change-password', auth, changePassword);

export default router;
