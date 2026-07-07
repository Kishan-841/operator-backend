import { Router } from 'express';
import {
  listProducts,
  listProductOptions,
  createProduct,
  updateProduct,
  deleteProduct,
} from '../controllers/storeProduct.controller.js';
import {
  listPurchaseOrders,
  getPurchaseOrder,
  createPurchaseOrder,
  approvePurchaseOrder,
  rejectPurchaseOrder,
  addToInventory,
  availableInventory,
  storeInventory,
} from '../controllers/purchaseOrder.controller.js';
import { auth, requireRole } from '../middleware/auth.js';

const router = Router();

router.use(auth);

// Store manager (+ admins) manage the catalogue + procurement. Admins approve
// POs. Delivery reads the product options list to raise material requests.
const canManage = requireRole('SUPER_ADMIN', 'ADMIN', 'STORE_USER');
const canRead = requireRole('SUPER_ADMIN', 'ADMIN', 'STORE_USER', 'DELIVERY_USER');
const canApprove = requireRole('SUPER_ADMIN', 'ADMIN');

// ── Product catalogue ────────────────────────────────────────────────────────
router.get('/products', canRead, listProducts);
router.get('/products/options', canRead, listProductOptions);
router.post('/products', canManage, createProduct);
router.put('/products/:id', canManage, updateProduct);
router.delete('/products/:id', canManage, deleteProduct);

// ── Procurement (purchase orders) ────────────────────────────────────────────
router.get('/purchase-orders', canManage, listPurchaseOrders);
router.get('/purchase-orders/:id', canManage, getPurchaseOrder);
router.post('/purchase-orders', canManage, createPurchaseOrder);
router.post('/purchase-orders/:id/add-to-inventory', canManage, addToInventory);
router.post('/po-approval/:id/approve', canApprove, approvePurchaseOrder);
router.post('/po-approval/:id/reject', canApprove, rejectPurchaseOrder);

// ── Inventory availability ───────────────────────────────────────────────────
router.get('/available-inventory', canManage, availableInventory);
router.get('/inventory', canManage, storeInventory);

export default router;
