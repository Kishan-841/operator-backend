import { Router } from 'express';
import {
  listVendors,
  listVendorOptions,
  createVendor,
  updateVendor,
  deleteVendor,
} from '../controllers/vendor.controller.js';
import { auth, requireRole } from '../middleware/auth.js';

const router = Router();

router.use(auth);

// Any authenticated user can read vendors (feasibility picks them as segments);
// only ADMIN / SALES_USER may create, edit, or delete.
const canManage = requireRole('SUPER_ADMIN', 'ADMIN', 'SALES_USER');

router.get('/', listVendors);
router.get('/options', listVendorOptions);
router.post('/', canManage, createVendor);
router.put('/:id', canManage, updateVendor);
router.delete('/:id', canManage, deleteVendor);

export default router;
