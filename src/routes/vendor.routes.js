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

// The vendor list carries bank details / commission % / GST / PAN — admin+sales
// only (it's the management surface). Feasibility picks vendors via /options,
// which projects only id/name/type/companyName, so it stays open to any staff.
const canManage = requireRole('SUPER_ADMIN', 'ADMIN', 'SALES_USER');

router.get('/', canManage, listVendors);
router.get('/options', listVendorOptions);
router.post('/', canManage, createVendor);
router.put('/:id', canManage, updateVendor);
router.delete('/:id', canManage, deleteVendor);

export default router;
