import { Router } from 'express';
import { listDocumentTypes, createDocumentType } from '../controllers/documentType.controller.js';
import { auth, requireRole } from '../middleware/auth.js';

const router = Router();

router.use(auth);
router.get('/', listDocumentTypes);
router.post('/', requireRole('SALES_USER', 'SOFTWARE_USER'), createDocumentType);

export default router;
