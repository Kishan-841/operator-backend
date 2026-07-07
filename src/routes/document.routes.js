import { Router } from 'express';
import {
  listAllDocuments,
  listDocumentCompanies,
  listDocumentTypes,
} from '../controllers/document.controller.js';
import { auth, requireRole } from '../middleware/auth.js';

const router = Router();

// Admin-only document browser. Per-document view/download reuses the existing
// /api/leads/:id/documents/:docId/download endpoint (admins bypass role gates).
router.use(auth, requireRole('SUPER_ADMIN', 'ADMIN'));
router.get('/companies', listDocumentCompanies);
router.get('/types', listDocumentTypes);
router.get('/', listAllDocuments);

export default router;
