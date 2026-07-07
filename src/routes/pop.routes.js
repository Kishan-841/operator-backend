import { Router } from 'express';
import { listPopLocations, createPopLocation } from '../controllers/pop.controller.js';
import { auth, requireRole } from '../middleware/auth.js';

const router = Router();

router.use(auth);
// Anyone authenticated can browse saved POPs; feasibility/sales (and admins) create.
router.get('/', listPopLocations);
router.post('/', requireRole('FEASIBILITY_USER', 'SALES_USER'), createPopLocation);

export default router;
