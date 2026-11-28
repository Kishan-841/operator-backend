import { Router } from 'express';
import { listPopLocations, createPopLocation, bulkCreatePopLocations, bulkUpdatePopLocations, updatePopLocation } from '../controllers/pop.controller.js';
import { auth, requireRole } from '../middleware/auth.js';

const router = Router();

router.use(auth);
// Anyone authenticated can browse saved POPs; feasibility/sales (and admins) create.
router.get('/', listPopLocations);
router.post('/', requireRole('FEASIBILITY_USER', 'SALES_USER'), createPopLocation);
router.post('/bulk', requireRole('FEASIBILITY_USER', 'SALES_USER'), bulkCreatePopLocations);
router.put('/:id', requireRole('FEASIBILITY_USER'), updatePopLocation);
// Bulk edit of existing locations (matched by ID) — same people who edit one.
router.post('/bulk-update', requireRole('FEASIBILITY_USER'), bulkUpdatePopLocations);

export default router;
