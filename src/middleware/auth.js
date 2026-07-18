import jwt from 'jsonwebtoken';
import prisma from '../config/db.js';
import { hasAnyRole } from '../utils/roleHelper.js';

/**
 * Authenticate via Bearer JWT. Loads the current user from the DB on every
 * request (cheap, indexed by PK) so a deactivated account is rejected
 * immediately rather than living until token expiry.
 */
export const auth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Access denied. No token provided.' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, email: true, name: true, role: true, accesses: true, isActive: true },
    });

    if (!user) {
      return res.status(401).json({ message: 'User not found.' });
    }
    if (!user.isActive) {
      return res.status(401).json({ message: 'Account is deactivated.' });
    }

    req.user = user;
    return next();
  } catch {
    return res.status(401).json({ message: 'Invalid token.' });
  }
};

/**
 * Gate a route to one or more roles. SUPER_ADMIN / ADMIN always pass.
 * Usage: router.post('/x', auth, requireRole('NOC_L2_USER'), handler)
 */
export const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ message: 'Authentication required.' });
  }
  // hasAnyRole admits admins and any staff user whose access set intersects.
  if (!hasAnyRole(req.user, roles)) {
    return res.status(403).json({ message: 'Access denied. Insufficient permissions.' });
  }
  return next();
};
