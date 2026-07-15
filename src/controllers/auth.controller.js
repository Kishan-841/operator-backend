import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '../config/db.js';
import { logEvent } from '../services/statusChangeLog.service.js';
import { actorFromReq } from '../utils/requestContext.js';

// Sessions expire after 1 hour (override with JWT_EXPIRES_IN). An expired
// token gets a 401 from the auth middleware; the frontend interceptor then
// drops the session and returns the user to /login.
const signToken = (user) =>
  jwt.sign({ userId: user.id, role: user.role }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '1h',
  });

const publicUser = (user) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  role: user.role,
});

/**
 * POST /api/auth/login
 * bcrypt-only. (We deliberately do NOT replicate ISP_CRM's plaintext-storage
 * "so admins can view passwords" behaviour — passwords stay hashed.)
 */
export const login = async (req, res) => {
  try {
    // `|| {}` guards probes / malformed requests that arrive without a JSON body.
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required.' });
    }

    // Record a failed attempt (attempted email + IP) — never the password.
    const logFailure = (attemptedEmail) =>
      logEvent({
        action: 'LOGIN_FAILED',
        entityType: 'Auth',
        summary: `Failed login for ${attemptedEmail}`,
        actor: actorFromReq(req, { id: null, label: attemptedEmail }),
      });

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });

    // Same response for unknown email and wrong password — don't leak which.
    if (!user || !user.isActive) {
      await logFailure(email);
      return res.status(401).json({ message: 'Invalid email or password.' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      await logFailure(email);
      return res.status(401).json({ message: 'Invalid email or password.' });
    }

    await logEvent({
      action: 'LOGIN_SUCCESS',
      entityType: 'Auth',
      entityId: user.id,
      summary: 'Signed in',
      actor: actorFromReq(req, { id: user.id, label: user.email }),
    });
    return res.json({
      message: 'Login successful',
      token: signToken(user),
      user: publicUser(user),
    });
  } catch (error) {
    console.error('[auth.login]', error);
    return res.status(500).json({ message: 'Login failed.' });
  }
};

/** GET /api/auth/me — returns the authenticated user (populated by auth middleware). */
export const me = async (req, res) => {
  return res.json({ user: publicUser(req.user) });
};

/**
 * POST /api/auth/logout — stateless JWT, so logout is client-side (drop the
 * token). Endpoint exists for symmetry and future server-side revocation.
 */
export const logout = async (_req, res) => {
  return res.json({ message: 'Logged out.' });
};
