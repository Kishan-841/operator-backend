import { Router } from 'express';
import { listPopLocations, createPopLocation, bulkCreatePopLocations, updatePopLocation } from '../controllers/pop.controller.js';
import { auth, requireRole } from '../middleware/auth.js';

const router = Router();

router.use(auth);
// Anyone authenticated can browse saved POPs; feasibility/sales (and admins) create.
router.get('/', listPopLocations);
router.post('/', requireRole('FEASIBILITY_USER', 'SALES_USER'), createPopLocation);
router.post('/bulk', requireRole('FEASIBILITY_USER', 'SALES_USER'), bulkCreatePopLocations);
router.put('/:id', requireRole('FEASIBILITY_USER'), updatePopLocation);

export default router;
