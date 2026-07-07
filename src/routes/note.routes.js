import { Router } from 'express';
import { listNotes, listNoteCompanies } from '../controllers/note.controller.js';
import { auth } from '../middleware/auth.js';

const router = Router();

// Any authenticated user can read the global notes feed (read-only context).
router.use(auth);
router.get('/companies', listNoteCompanies);
router.get('/', listNotes);

export default router;
