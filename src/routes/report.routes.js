import { Router } from 'express';
import { overview, leadMetrics, myDashboard } from '../controllers/report.controller.js';
import { auth, requireRole } from '../middleware/auth.js';

const router = Router();

router.use(auth);
router.get('/my-dashboard', myDashboard); // any authenticated user — their own data
router.get('/overview', requireRole('SUPER_ADMIN', 'ADMIN'), overview);
router.get('/lead-metrics', requireRole('SUPER_ADMIN', 'ADMIN'), leadMetrics);

export default router;
