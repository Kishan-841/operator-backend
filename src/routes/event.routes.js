import { Router } from 'express';
import { getEvents } from '../controllers/event.controller.js';
import { auth, requireRole } from '../middleware/auth.js';

const router = Router();

router.use(auth, requireRole('SUPER_ADMIN', 'ADMIN'));
router.get('/', getEvents);

export default router;
