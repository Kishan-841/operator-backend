import { Router } from 'express';
import {
  listDistributors,
  distributorOptions,
  createDistributor,
  updateDistributor,
  deleteDistributor,
  distributorLeads,
} from '../controllers/distributor.controller.js';
import { auth, requireRole } from '../middleware/auth.js';

const router = Router();

router.use(auth);

// The picker is used on the (sales-owned) lead form; management is admin-only.
const adminOnly = requireRole('SUPER_ADMIN', 'ADMIN');

router.get('/options', distributorOptions); // any authenticated staff
router.get('/', adminOnly, listDistributors);
router.post('/', adminOnly, createDistributor);
router.put('/:id', adminOnly, updateDistributor);
router.delete('/:id', adminOnly, deleteDistributor);
router.get('/:id/leads', adminOnly, distributorLeads);

export default router;
