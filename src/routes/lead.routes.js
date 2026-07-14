import { Router } from 'express';
import { createLead, getLeads, getLead, updateLead, updateIpDetails } from '../controllers/lead.controller.js';
import { getLeadNotes } from '../controllers/note.controller.js';
import { generateAgreement } from '../controllers/agreement.controller.js';
import {
  feasibilityQueue,
  pricingQueue,
  approvalsQueue,
  docsQueue,
  deliveryQueue,
  materialApprovalQueue,
  storeQueue,
  installationQueue,
  nocL2Queue,
  aggregatorQueue,
  softwareQueue,
  docsVerifyQueue,
  nocL3Queue,
  l3ToL2Queue,
  clientHandoverQueue,
  agreementQueue,
  sidebarCounts,
  aggregatorOptions,
} from '../controllers/lead.queues.controller.js';
import {
  submitFeasibility,
  completeFeasibility,
  submitPricing,
  approveLead,
  rejectLead,
  submitDocsForVerification,
  completeDocs,
  submitMaterialReq,
  skipMaterialReq,
  approveMaterialRequest,
  rejectMaterialRequest,
  assignMaterial,
  completeInstallation,
  completeNocL2,
  confirmAggregator,
  completeSoftware,
  completeNocL3,
  completeL3ToL2,
  assignL3ToL2,
  completeClientHandover,
  markAgreementSentForSignature,
  verifyAgreement,
} from '../controllers/lead.transitions.controller.js';
import {
  uploadDocument,
  listDocuments,
  downloadDocument,
  deleteDocument,
  setDocumentVerification,
  setDocumentSalesApproval,
} from '../controllers/lead.documents.controller.js';
import { auth, requireRole } from '../middleware/auth.js';
import { uploadSingle, uploadArray } from '../config/upload.js';

const router = Router();
router.use(auth);

// --- Reads (literal paths before '/:id') ---
router.get('/', requireRole('SALES_USER'), getLeads);
router.get('/sidebar-counts', sidebarCounts); // any authenticated staff
router.get('/aggregator-options', aggregatorOptions); // any authenticated staff
router.get('/feasibility/queue', requireRole('FEASIBILITY_USER'), feasibilityQueue);
router.get('/pricing/queue', requireRole('SALES_USER'), pricingQueue);
router.get('/approvals/queue', requireRole('SUPER_ADMIN', 'ADMIN'), approvalsQueue);
router.get('/docs/queue', requireRole('SALES_USER'), docsQueue);
router.get('/docs-verify/queue', requireRole('SOFTWARE_USER'), docsVerifyQueue);
router.get('/delivery/queue', requireRole('DELIVERY_USER'), deliveryQueue);
router.get('/store/queue', requireRole('STORE_USER'), storeQueue);
router.get('/installation/queue', requireRole('DELIVERY_USER'), installationQueue);
router.get('/material-approval/queue', requireRole('SUPER_ADMIN', 'ADMIN'), materialApprovalQueue);
router.get('/nocl2/queue', requireRole('NOC_L2_USER'), nocL2Queue);
router.get('/aggregator/queue', requireRole('SALES_USER'), aggregatorQueue);
router.get('/software/queue', requireRole('SOFTWARE_USER'), softwareQueue);
router.get('/nocl3/queue', requireRole('NOC_L3_USER'), nocL3Queue);
router.get('/l3-to-l2/queue', requireRole('NOC_L2_USER', 'NOC_L3_USER'), l3ToL2Queue);
router.get('/client-handover/queue', requireRole('SALES_USER'), clientHandoverQueue);
router.get('/agreement/queue', requireRole('SOFTWARE_USER'), agreementQueue);
router.get('/:id', requireRole('SALES_USER'), getLead);
// Note timeline for a lead — any authenticated user (read-only context).
router.get('/:id/notes', getLeadNotes);

// --- CRUD ---
router.post('/', requireRole('SALES_USER'), createLead);
router.put('/:id', requireRole('SALES_USER'), updateLead);
router.patch('/:id/ip-details', requireRole('SALES_USER'), updateIpDetails);

// --- Stage transitions (2–4) ---
router.post('/:id/submit-feasibility', requireRole('SALES_USER'), submitFeasibility);
router.post('/:id/feasibility', requireRole('FEASIBILITY_USER'), completeFeasibility);
router.post('/:id/pricing', requireRole('SALES_USER'), submitPricing);
router.post('/:id/approve', requireRole('SUPER_ADMIN', 'ADMIN'), approveLead);
router.post('/:id/reject', requireRole('SUPER_ADMIN', 'ADMIN'), rejectLead);

// --- Documents (SALES at stage 5; SOFTWARE attaches the agreement at stage 15) ---
router.post('/:id/documents', requireRole('SALES_USER', 'SOFTWARE_USER'), uploadSingle('file'), uploadDocument);
// Documents are sales/software territory (approved visibility matrix).
router.get('/:id/documents', requireRole('SALES_USER', 'SOFTWARE_USER'), listDocuments);
router.get('/:id/documents/:docId/download', requireRole('SALES_USER', 'SOFTWARE_USER'), downloadDocument);
router.delete('/:id/documents/:docId', requireRole('SALES_USER', 'SOFTWARE_USER'), deleteDocument);
// Stage-11 docs verification (SOFTWARE).
router.patch('/:id/documents/:docId/verification', requireRole('SOFTWARE_USER'), setDocumentVerification);
router.patch('/:id/documents/:docId/sales-approve', requireRole('SOFTWARE_USER'), setDocumentSalesApproval);
router.post('/:id/submit-docs-verification', requireRole('SALES_USER'), submitDocsForVerification);
router.post('/:id/complete-docs', requireRole('SOFTWARE_USER'), completeDocs);

// --- Stage 6 + 7 transitions ---
router.post('/:id/material-req', requireRole('DELIVERY_USER'), submitMaterialReq);
router.post('/:id/skip-material', requireRole('DELIVERY_USER'), skipMaterialReq);
router.post('/:id/approve-material', requireRole('SUPER_ADMIN', 'ADMIN'), approveMaterialRequest);
router.post('/:id/reject-material', requireRole('SUPER_ADMIN', 'ADMIN'), rejectMaterialRequest);
router.post('/:id/assign-material', requireRole('STORE_USER'), assignMaterial);

// --- Stage 8–13 transitions ---
router.post('/:id/install', requireRole('DELIVERY_USER'), completeInstallation);
router.post('/:id/noc-l2', requireRole('NOC_L2_USER'), completeNocL2);
router.post('/:id/aggregator', requireRole('SALES_USER'), confirmAggregator);
router.post('/:id/software', requireRole('SOFTWARE_USER'), completeSoftware);
router.post('/:id/noc-l3', requireRole('NOC_L3_USER'), completeNocL3);
router.post('/:id/l3-to-l2', requireRole('NOC_L2_USER', 'NOC_L3_USER'), completeL3ToL2);
router.post('/:id/l3-to-l2/assign', requireRole('NOC_L3_USER'), assignL3ToL2);
router.post(
  '/:id/agreement/generate',
  requireRole('SOFTWARE_USER', 'SALES_USER'),
  uploadArray('attachments', 10),
  generateAgreement,
);

// --- Stage 14 + 15 transitions ---
router.post('/:id/client-handover', requireRole('SALES_USER'), completeClientHandover);
router.post('/:id/agreement/sent-for-signature', requireRole('SOFTWARE_USER'), markAgreementSentForSignature);
router.post('/:id/verify-agreement', requireRole('SOFTWARE_USER'), verifyAgreement);

export default router;

