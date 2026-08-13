import { Router } from 'express';
import { getLeadMap } from '../controllers/map.controller.js';
import { auth, requireRole } from '../middleware/auth.js';

const router = Router();

router.use(auth);
// The lead map is an admin overview of the whole pipeline's geography.
router.get('/', requireRole('SUPER_ADMIN', 'ADMIN'), getLeadMap);

export default router;
