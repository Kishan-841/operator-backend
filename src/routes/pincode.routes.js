import { Router } from 'express';
import { listPincodes } from '../controllers/pincode.controller.js';
import { auth } from '../middleware/auth.js';

const router = Router();

router.use(auth);
// Any authenticated staff can search the pincode master (Territory picker).
router.get('/', listPincodes);

export default router;
