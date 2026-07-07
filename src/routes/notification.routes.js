import { Router } from 'express';
import { getNotifications, markRead, markAllRead } from '../controllers/notification.controller.js';
import { auth } from '../middleware/auth.js';

const router = Router();

router.use(auth);
router.get('/', getNotifications);
router.post('/read-all', markAllRead);
router.post('/:id/read', markRead);

export default router;
