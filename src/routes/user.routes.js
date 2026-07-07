import { Router } from 'express';
import {
  getUsers,
  getUsersByRole,
  getUserById,
  createUser,
  updateUser,
  setUserActive,
  resetUserPassword,
} from '../controllers/user.controller.js';
import { auth, requireRole } from '../middleware/auth.js';

const router = Router();

router.use(auth);

// List active users by role — used by assignment dropdowns (NOC L3 assigning the
// L3→L2 handoff to a NOC L2 user). Scoped to the roles that actually need it so
// we don't broaden user enumeration to every authenticated user.
router.get('/by-role', requireRole('NOC_L3_USER', 'SUPER_ADMIN', 'ADMIN'), getUsersByRole);

// Everything else is admin-only.
router.use(requireRole('SUPER_ADMIN', 'ADMIN'));

router.get('/', getUsers);
router.get('/:id', getUserById);
router.post('/', createUser);
router.put('/:id', updateUser);
router.patch('/:id/active', setUserActive);
router.post('/:id/reset-password', resetUserPassword);

export default router;
