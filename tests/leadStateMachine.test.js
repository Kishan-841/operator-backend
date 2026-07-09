import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import * as sm from '../src/services/leadStateMachine.js';
import { validateFeasibilityVendors } from '../src/validation/feasibilityVendors.js';
import {
  prisma,
  seedUsers,
  actor,
  createLead,
  addDocument,
  addApprovedDocument,
  addRequiredDocs,
  createProduct,
  createStock,
  createApprovedRequestLead,
  status,
  cleanup,
  rejectsWithStatus,
} from './helpers.mjs';

before(async () => {
  await seedUsers();
  await cleanup();
});
beforeEach(cleanup);
after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

// ── Stage 1 → 2 ────────────────────────────────────────────────────────────
test('submitForFeasibility moves NEW → FEASIBILITY_PENDING', async () => {
  const lead = await createLead();
  const updated = await sm.submitForFeasibility({ leadId: lead.id, actor: actor('SALES_USER') });
  assert.equal(updated.status, 'FEASIBILITY_PENDING');
});

test('submitForFeasibility from a wrong status throws 409', async () => {
  const lead = await createLead({ status: 'PRICING_PENDING' });
  await rejectsWithStatus(() => sm.submitForFeasibility({ leadId: lead.id, actor: actor('SALES_USER') }), 409);
});

// ── Stage 2: feasibility ─────────────────────────────────────────────────────
test('completeFeasibility (feasible) → PRICING_PENDING and records review', async () => {
  const lead = await createLead({ status: 'FEASIBILITY_PENDING' });
  const updated = await sm.completeFeasibility({
    leadId: lead.id,
    actor: actor('FEASIBILITY_USER'),
    feasible: true,
    notes: 'looks good',
    vendors: [{ kind: 'OWN', fiberMeters: 500 }],
  });
  assert.equal(updated.status, 'PRICING_PENDING');
  assert.ok(updated.feasibilityReviewedAt);
  assert.equal(updated.feasibilityVendors[0].kind, 'OWN');
  assert.equal(updated.feasibilityVendors[0].fiberMeters, 500);
  // The note is captured in the timeline.
  const notes = await prisma.leadNote.findMany({ where: { leadId: lead.id, stage: 'FEASIBILITY' } });
  assert.equal(notes.length, 1);
  assert.equal(notes[0].body, 'looks good');
});

test('completeFeasibility (feasible) snapshots a vendor segment name + type + path', async () => {
  const lead = await createLead({ status: 'FEASIBILITY_PENDING' });
  const vendor = await prisma.vendor.create({ data: { type: 'FIBER', name: 'Acme Fiber' } });
  const updated = await sm.completeFeasibility({
    leadId: lead.id,
    actor: actor('FEASIBILITY_USER'),
    feasible: true,
    notes: '',
    vendors: [
      { kind: 'OWN', fiberMeters: 200 },
      {
        kind: 'VENDOR',
        vendorId: vendor.id,
        fiberMeters: 300,
        path: { a: { lat: 12.9, lng: 77.5 }, b: { lat: 13.0, lng: 77.6 } },
      },
    ],
  });
  const seg = updated.feasibilityVendors[1];
  assert.equal(seg.vendorId, vendor.id);
  assert.equal(seg.vendorName, 'Acme Fiber');
  assert.equal(seg.vendorType, 'FIBER');
  assert.equal(seg.path.b.lng, 77.6);
});

test('completeFeasibility (feasible) stores a Client Fiber segment as free-text, no vendor lookup', async () => {
  const lead = await createLead({ status: 'FEASIBILITY_PENDING' });
  const updated = await sm.completeFeasibility({
    leadId: lead.id,
    actor: actor('FEASIBILITY_USER'),
    feasible: true,
    notes: '',
    vendors: [
      { kind: 'CLIENT', clientName: 'Globe Telecom Ltd', fiberMeters: 150 },
    ],
  });
  const seg = updated.feasibilityVendors[0];
  assert.equal(seg.kind, 'CLIENT');
  assert.equal(seg.clientName, 'Globe Telecom Ltd');
  assert.equal(seg.fiberMeters, 150);
  assert.equal(seg.vendorId, undefined);
});

test('validateFeasibilityVendors rejects a Client Fiber segment with no client name', () => {
  const result = validateFeasibilityVendors([{ kind: 'CLIENT', fiberMeters: 150 }]);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path.endsWith('clientName')));
});

test('validateFeasibilityVendors accepts a Client Fiber segment with a client name', () => {
  const result = validateFeasibilityVendors([
    { kind: 'CLIENT', clientName: 'Globe Telecom', fiberMeters: 150 },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.data[0].clientName, 'Globe Telecom');
});

test('completeFeasibility (feasible) with no segments → 400', async () => {
  const lead = await createLead({ status: 'FEASIBILITY_PENDING' });
  await rejectsWithStatus(
    () =>
      sm.completeFeasibility({
        leadId: lead.id,
        actor: actor('FEASIBILITY_USER'),
        feasible: true,
        notes: '',
        vendors: [],
      }),
    400,
  );
});

test('completeFeasibility (feasible) with a non-existent vendor → 400', async () => {
  const lead = await createLead({ status: 'FEASIBILITY_PENDING' });
  await rejectsWithStatus(
    () =>
      sm.completeFeasibility({
        leadId: lead.id,
        actor: actor('FEASIBILITY_USER'),
        feasible: true,
        notes: '',
        vendors: [{ kind: 'VENDOR', vendorId: '00000000-0000-4000-8000-000000000000', fiberMeters: 100 }],
      }),
    400,
  );
});

test('completeFeasibility (not feasible) requires a reason, else 400', async () => {
  const lead = await createLead({ status: 'FEASIBILITY_PENDING' });
  await rejectsWithStatus(
    () => sm.completeFeasibility({ leadId: lead.id, actor: actor('FEASIBILITY_USER'), feasible: false, notes: '' }),
    400,
  );
});

test('completeFeasibility (not feasible) → REJECTED with reason', async () => {
  const lead = await createLead({ status: 'FEASIBILITY_PENDING' });
  const updated = await sm.completeFeasibility({
    leadId: lead.id,
    actor: actor('FEASIBILITY_USER'),
    feasible: false,
    notes: 'no fiber in area',
  });
  assert.equal(updated.status, 'REJECTED');
  assert.equal(updated.rejectedReason, 'no fiber in area');
});

// ── Stage 3 → 4: pricing + approval ──────────────────────────────────────────
test('submitPricing → PENDING_APPROVAL and stores pricing', async () => {
  const lead = await createLead({ status: 'PRICING_PENDING' });
  const updated = await sm.submitPricing({
    leadId: lead.id,
    actor: actor('SALES_USER'),
    pricing: { ratePerMonth: 5000 },
  });
  assert.equal(updated.status, 'PENDING_APPROVAL');
  assert.equal(updated.pricing.ratePerMonth, 5000);
});

test('approveLead → APPROVED', async () => {
  const lead = await createLead({ status: 'PENDING_APPROVAL' });
  const updated = await sm.approveLead({ leadId: lead.id, actor: actor('ADMIN') });
  assert.equal(updated.status, 'APPROVED');
  assert.ok(updated.approvedAt);
});

// ── Reject = send back to pricing (non-terminal) ─────────────────────────────
test('rejectLead requires a reason, else 400', async () => {
  const lead = await createLead({ status: 'PENDING_APPROVAL' });
  await rejectsWithStatus(() => sm.rejectLead({ leadId: lead.id, actor: actor('ADMIN'), reason: '  ' }), 400);
});

test('rejectLead sends lead BACK to PRICING_PENDING with a revision reason (not terminal)', async () => {
  const lead = await createLead({ status: 'PENDING_APPROVAL' });
  const updated = await sm.rejectLead({ leadId: lead.id, actor: actor('ADMIN'), reason: 'rate too low' });
  assert.equal(updated.status, 'PRICING_PENDING');
  assert.equal(updated.pricingRevisionReason, 'rate too low');
  assert.equal(updated.pricingRevisionCount, 1);
});

test('each send-back increments pricingRevisionCount', async () => {
  const lead = await createLead({ status: 'PENDING_APPROVAL' });
  await sm.rejectLead({ leadId: lead.id, actor: actor('ADMIN'), reason: 'first' });
  await sm.submitPricing({ leadId: lead.id, actor: actor('SALES_USER'), pricing: { ratePerMonth: 100 } });
  const updated = await sm.rejectLead({ leadId: lead.id, actor: actor('ADMIN'), reason: 'second' });
  assert.equal(updated.pricingRevisionCount, 2);
});

test('resubmitting pricing after a send-back clears the revision reason', async () => {
  const lead = await createLead({ status: 'PRICING_PENDING', pricingRevisionReason: 'rate too low' });
  const updated = await sm.submitPricing({
    leadId: lead.id,
    actor: actor('SALES_USER'),
    pricing: { ratePerMonth: 8000 },
  });
  assert.equal(updated.status, 'PENDING_APPROVAL');
  assert.equal(updated.pricingRevisionReason, null);
});

// ── Stage 5a: docs upload → send for verification ────────────────────────────
test('submitDocsForVerification works with ZERO documents — docs are optional here', async () => {
  const lead = await createLead({ status: 'APPROVED' });
  const updated = await sm.submitDocsForVerification({ leadId: lead.id, actor: actor('SALES_USER') });
  assert.equal(updated.status, 'DOCS_UPLOADED');
});

test('submitDocsForVerification with a document → DOCS_UPLOADED (no approval needed yet)', async () => {
  const lead = await createLead({ status: 'APPROVED' });
  await addDocument(lead.id); // unapproved — approval happens in the verify step
  const updated = await sm.submitDocsForVerification({ leadId: lead.id, actor: actor('SALES_USER') });
  assert.equal(updated.status, 'DOCS_UPLOADED');
});

test('submitDocsForVerification from a wrong status → 409', async () => {
  const lead = await createLead({ status: 'DOCS_UPLOADED' });
  await addDocument(lead.id);
  await rejectsWithStatus(
    () => sm.submitDocsForVerification({ leadId: lead.id, actor: actor('SALES_USER') }),
    409,
  );
});

// ── Stage 5b: docs verify → complete ─────────────────────────────────────────
test('completeDocs with all documents approved → DELIVERY_REQ_PENDING', async () => {
  const lead = await createLead({ status: 'DOCS_UPLOADED' });
  await addApprovedDocument(lead.id);
  const updated = await sm.completeDocs({ leadId: lead.id, actor: actor('SOFTWARE_USER') });
  assert.equal(updated.status, 'DELIVERY_REQ_PENDING');
});

test('completeDocs with ZERO documents proceeds — nothing to verify yet', async () => {
  const lead = await createLead({ status: 'DOCS_UPLOADED' });
  const updated = await sm.completeDocs({ leadId: lead.id, actor: actor('SOFTWARE_USER') });
  assert.equal(updated.status, 'DELIVERY_REQ_PENDING');
});

test('completeDocs from the upload stage (APPROVED) → 409, must send for verification first', async () => {
  const lead = await createLead({ status: 'APPROVED' });
  await addApprovedDocument(lead.id);
  // Software can't even see upload-stage leads (404); the admin surfaces the
  // explicit wrong-stage conflict.
  await rejectsWithStatus(() => sm.completeDocs({ leadId: lead.id, actor: actor('SOFTWARE_USER') }), 404);
  await rejectsWithStatus(() => sm.completeDocs({ leadId: lead.id, actor: actor('ADMIN') }), 409);
  assert.equal(await status(lead.id), 'APPROVED');
});

// Regression: OPC-0025 skipped sales doc approval because this gate didn't
// exist yet. The lead must NOT leave the verify stage with unapproved docs.
test('completeDocs with an unapproved document → 400, lead stays at verify', async () => {
  const lead = await createLead({ status: 'DOCS_UPLOADED' });
  await addDocument(lead.id); // no salesApprovedAt
  await rejectsWithStatus(() => sm.completeDocs({ leadId: lead.id, actor: actor('SOFTWARE_USER') }), 400);
  assert.equal(await status(lead.id), 'DOCS_UPLOADED');
});

test('completeDocs blocks while ANY document is unapproved', async () => {
  const lead = await createLead({ status: 'DOCS_UPLOADED' });
  await addApprovedDocument(lead.id, 'PAN');
  await addDocument(lead.id, 'GST'); // second doc not yet approved
  await rejectsWithStatus(() => sm.completeDocs({ leadId: lead.id, actor: actor('SOFTWARE_USER') }), 400);
  assert.equal(await status(lead.id), 'DOCS_UPLOADED');
});

// ── Stage 11 → 5: docs rejection send-back ───────────────────────────────────
test('rejectDocs sends the lead from the verify stage back to upload with the reason', async () => {
  const lead = await createLead({ status: 'DOCS_UPLOADED' });
  const updated = await sm.rejectDocs({
    leadId: lead.id,
    actor: actor('SOFTWARE_USER'),
    reason: 'PAN scan unreadable',
  });
  assert.equal(updated.status, 'APPROVED');
  assert.equal(updated.docsRevisionReason, 'PAN scan unreadable');
  assert.equal(updated.docsRevisionCount, 1);
});

test('rejectDocs requires a reason and the docs-verify stage', async () => {
  const atVerify = await createLead({ status: 'DOCS_UPLOADED' });
  await rejectsWithStatus(
    () => sm.rejectDocs({ leadId: atVerify.id, actor: actor('SOFTWARE_USER'), reason: '' }),
    400,
  );
  const elsewhere = await createLead({ status: 'SOFTWARE_PENDING' });
  await rejectsWithStatus(
    () => sm.rejectDocs({ leadId: elsewhere.id, actor: actor('SOFTWARE_USER'), reason: 'x' }),
    409,
  );
});

test('completeDocs after a rejection continues to delivery and clears the reason', async () => {
  const lead = await createLead({ status: 'DOCS_UPLOADED' });
  await addApprovedDocument(lead.id);
  await sm.rejectDocs({ leadId: lead.id, actor: actor('SOFTWARE_USER'), reason: 'blurry' });
  // Rejection lands back at the upload stage → re-send for verification → complete.
  assert.equal(await status(lead.id), 'APPROVED');
  await sm.submitDocsForVerification({ leadId: lead.id, actor: actor('SALES_USER') });
  const updated = await sm.completeDocs({ leadId: lead.id, actor: actor('SOFTWARE_USER') });
  // Rejection happens BEFORE delivery now (stage 5b), so completion always
  // continues down the normal pipeline.
  assert.equal(updated.status, 'DELIVERY_REQ_PENDING');
  assert.equal(updated.docsRevisionReason, null);
  assert.equal(updated.docsRevisionCount, 1); // count preserved for audit
});

// ── Stage 6: material request (catalog) + admin approval ─────────────────────
test('submitMaterialReq → MATERIAL_APPROVAL_PENDING and creates a DeliveryRequest with items', async () => {
  const lead = await createLead({ status: 'DELIVERY_REQ_PENDING' });
  const product = await createProduct();
  const updated = await sm.submitMaterialReq({
    leadId: lead.id,
    actor: actor('DELIVERY_USER'),
    items: [{ productId: product.id, quantity: 2 }],
    notes: 'urgent',
  });
  assert.equal(updated.status, 'MATERIAL_APPROVAL_PENDING');
  const dr = await prisma.deliveryRequest.findUnique({ where: { leadId: lead.id }, include: { items: true } });
  assert.ok(dr, 'delivery request created');
  assert.match(dr.requestNumber, /^DR-\d{4}$/);
  assert.equal(dr.status, 'PENDING_APPROVAL');
  assert.equal(dr.items.length, 1);
  assert.equal(dr.items[0].quantity, 2);
});

test('submitMaterialReq requires at least one item → 400', async () => {
  const lead = await createLead({ status: 'DELIVERY_REQ_PENDING' });
  await rejectsWithStatus(
    () => sm.submitMaterialReq({ leadId: lead.id, actor: actor('DELIVERY_USER'), items: [] }),
    400,
  );
  assert.equal(await status(lead.id), 'DELIVERY_REQ_PENDING');
});

test('approveMaterialRequest → AWAITING_DISPATCH and marks the DR APPROVED', async () => {
  const lead = await createLead({ status: 'DELIVERY_REQ_PENDING' });
  const product = await createProduct();
  await sm.submitMaterialReq({ leadId: lead.id, actor: actor('DELIVERY_USER'), items: [{ productId: product.id, quantity: 1 }] });
  const updated = await sm.approveMaterialRequest({ leadId: lead.id, actor: actor('ADMIN') });
  assert.equal(updated.status, 'AWAITING_DISPATCH');
  const dr = await prisma.deliveryRequest.findUnique({ where: { leadId: lead.id } });
  assert.equal(dr.status, 'APPROVED');
  assert.ok(dr.superAdminApprovedAt);
});

test('approveMaterialRequest from a wrong status → 409', async () => {
  const lead = await createLead({ status: 'AWAITING_DISPATCH' });
  await rejectsWithStatus(() => sm.approveMaterialRequest({ leadId: lead.id, actor: actor('ADMIN') }), 409);
});

test('rejectMaterialRequest → DELIVERY_REQ_PENDING with a reason and DR REJECTED', async () => {
  const lead = await createLead({ status: 'DELIVERY_REQ_PENDING' });
  const product = await createProduct();
  await sm.submitMaterialReq({ leadId: lead.id, actor: actor('DELIVERY_USER'), items: [{ productId: product.id, quantity: 1 }] });
  const updated = await sm.rejectMaterialRequest({ leadId: lead.id, actor: actor('ADMIN'), reason: 'wrong switch model' });
  assert.equal(updated.status, 'DELIVERY_REQ_PENDING');
  const dr = await prisma.deliveryRequest.findUnique({ where: { leadId: lead.id } });
  assert.equal(dr.status, 'REJECTED');
  assert.equal(dr.superAdminRejectionReason, 'wrong switch model');
});

test('rejectMaterialRequest requires a reason → 400', async () => {
  const lead = await createLead({ status: 'DELIVERY_REQ_PENDING' });
  const product = await createProduct();
  await sm.submitMaterialReq({ leadId: lead.id, actor: actor('DELIVERY_USER'), items: [{ productId: product.id, quantity: 1 }] });
  await rejectsWithStatus(
    () => sm.rejectMaterialRequest({ leadId: lead.id, actor: actor('ADMIN'), reason: '' }),
    400,
  );
  assert.equal(await status(lead.id), 'MATERIAL_APPROVAL_PENDING');
});

test('resubmitting after a rejection reuses the same DeliveryRequest and returns to approval', async () => {
  const lead = await createLead({ status: 'DELIVERY_REQ_PENDING' });
  const product = await createProduct();
  await sm.submitMaterialReq({ leadId: lead.id, actor: actor('DELIVERY_USER'), items: [{ productId: product.id, quantity: 1 }] });
  await sm.rejectMaterialRequest({ leadId: lead.id, actor: actor('ADMIN'), reason: 'redo' });
  const p2 = await createProduct();
  await sm.submitMaterialReq({ leadId: lead.id, actor: actor('DELIVERY_USER'), items: [{ productId: p2.id, quantity: 3 }] });
  assert.equal(await status(lead.id), 'MATERIAL_APPROVAL_PENDING');
  const drs = await prisma.deliveryRequest.findMany({ where: { leadId: lead.id }, include: { items: true } });
  assert.equal(drs.length, 1, 'still one DR (reused, not duplicated)');
  assert.equal(drs[0].status, 'PENDING_APPROVAL');
  assert.equal(drs[0].items.length, 1);
  assert.equal(drs[0].items[0].quantity, 3);
});

// ── Stage 7: store assigns material from inventory ───────────────────────────
test('assignMaterial: serialized item fully assigned from one PO → DISPATCHED, serials deducted', async () => {
  const product = await createProduct();
  const dr = await createApprovedRequestLead([{ productId: product.id, quantity: 2 }]);
  const po = await createStock({ productId: product.id, serialNumbers: ['SN-1', 'SN-2', 'SN-3'] });
  const poItem = po.items[0];

  const updated = await sm.assignMaterial({
    leadId: dr.leadId,
    actor: actor('STORE_USER'),
    assignments: [{ itemId: dr.items[0].id, sources: [{ poItemId: poItem.id, serialNumbers: ['SN-1', 'SN-2'] }] }],
  });
  assert.equal(updated.status, 'DISPATCHED');

  const item = await prisma.deliveryRequestItem.findUnique({ where: { id: dr.items[0].id } });
  assert.equal(item.isAssigned, true);
  assert.deepEqual(item.assignedSerialNumbers.sort(), ['SN-1', 'SN-2']);

  const after = await prisma.storePurchaseOrderItem.findUnique({ where: { id: poItem.id } });
  assert.deepEqual(after.serialNumbers.sort(), ['SN-3'], 'assigned serials removed from the PO item');

  const drAfter = await prisma.deliveryRequest.findUnique({ where: { id: dr.id } });
  assert.equal(drAfter.status, 'ASSIGNED');
});

test('assignMaterial: one item drawn across TWO POs → union recorded, both deducted', async () => {
  const product = await createProduct();
  const dr = await createApprovedRequestLead([{ productId: product.id, quantity: 2 }]);
  const poA = await createStock({ productId: product.id, serialNumbers: ['A-1'] });
  const poB = await createStock({ productId: product.id, serialNumbers: ['B-1', 'B-2'] });

  const updated = await sm.assignMaterial({
    leadId: dr.leadId,
    actor: actor('STORE_USER'),
    assignments: [
      {
        itemId: dr.items[0].id,
        sources: [
          { poItemId: poA.items[0].id, serialNumbers: ['A-1'] },
          { poItemId: poB.items[0].id, serialNumbers: ['B-1'] },
        ],
      },
    ],
  });
  assert.equal(updated.status, 'DISPATCHED');
  const item = await prisma.deliveryRequestItem.findUnique({ where: { id: dr.items[0].id } });
  assert.deepEqual(item.assignedSerialNumbers.sort(), ['A-1', 'B-1']);
  const bAfter = await prisma.storePurchaseOrderItem.findUnique({ where: { id: poB.items[0].id } });
  assert.deepEqual(bAfter.serialNumbers.sort(), ['B-2']);
});

test('assignMaterial: partial assignment (fewer serials than requested) → 400, nothing deducted', async () => {
  const product = await createProduct();
  const dr = await createApprovedRequestLead([{ productId: product.id, quantity: 2 }]);
  const po = await createStock({ productId: product.id, serialNumbers: ['SN-1', 'SN-2'] });
  await rejectsWithStatus(
    () =>
      sm.assignMaterial({
        leadId: dr.leadId,
        actor: actor('STORE_USER'),
        assignments: [{ itemId: dr.items[0].id, sources: [{ poItemId: po.items[0].id, serialNumbers: ['SN-1'] }] }],
      }),
    400,
  );
  assert.equal(await status(dr.leadId), 'AWAITING_DISPATCH');
  const after = await prisma.storePurchaseOrderItem.findUnique({ where: { id: po.items[0].id } });
  assert.equal(after.serialNumbers.length, 2, 'no serials deducted on a failed assign');
});

test('assignMaterial: serial not held by the PO item → 400', async () => {
  const product = await createProduct();
  const dr = await createApprovedRequestLead([{ productId: product.id, quantity: 1 }]);
  const po = await createStock({ productId: product.id, serialNumbers: ['SN-1'] });
  await rejectsWithStatus(
    () =>
      sm.assignMaterial({
        leadId: dr.leadId,
        actor: actor('STORE_USER'),
        assignments: [{ itemId: dr.items[0].id, sources: [{ poItemId: po.items[0].id, serialNumbers: ['GHOST'] }] }],
      }),
    400,
  );
});

test('assignMaterial: bulk item assigned by quantity → deducts receivedQuantity', async () => {
  const product = await createProduct({ modelNumber: 'FIB-ASSIGN', category: 'FIBER', unit: 'mtrs' });
  const dr = await createApprovedRequestLead([{ productId: product.id, quantity: 300 }]);
  const po = await createStock({ productId: product.id, receivedQuantity: 500 });

  const updated = await sm.assignMaterial({
    leadId: dr.leadId,
    actor: actor('STORE_USER'),
    assignments: [{ itemId: dr.items[0].id, bulk: { poItemId: po.items[0].id, quantity: 300 } }],
  });
  assert.equal(updated.status, 'DISPATCHED');
  const after = await prisma.storePurchaseOrderItem.findUnique({ where: { id: po.items[0].id } });
  assert.equal(after.receivedQuantity, 200, '500 − 300 = 200 left');
  const item = await prisma.deliveryRequestItem.findUnique({ where: { id: dr.items[0].id } });
  assert.equal(item.assignedQuantity, 300);
});

test('assignMaterial: from a wrong status → 409', async () => {
  const product = await createProduct();
  const dr = await createApprovedRequestLead([{ productId: product.id, quantity: 1 }]);
  await prisma.lead.update({ where: { id: dr.leadId }, data: { status: 'DISPATCHED' } });
  const po = await createStock({ productId: product.id, serialNumbers: ['SN-1'] });
  await rejectsWithStatus(
    () =>
      sm.assignMaterial({
        leadId: dr.leadId,
        actor: actor('STORE_USER'),
        assignments: [{ itemId: dr.items[0].id, sources: [{ poItemId: po.items[0].id, serialNumbers: ['SN-1'] }] }],
      }),
    409,
  );
});

test('assignMaterial concurrency: the same serial cannot be assigned to two leads', async () => {
  const product = await createProduct();
  const drA = await createApprovedRequestLead([{ productId: product.id, quantity: 1 }]);
  const drB = await createApprovedRequestLead([{ productId: product.id, quantity: 1 }]);
  const po = await createStock({ productId: product.id, serialNumbers: ['ONLY-1'] });
  const poItemId = po.items[0].id;

  const results = await Promise.allSettled([
    sm.assignMaterial({
      leadId: drA.leadId,
      actor: actor('STORE_USER'),
      assignments: [{ itemId: drA.items[0].id, sources: [{ poItemId, serialNumbers: ['ONLY-1'] }] }],
    }),
    sm.assignMaterial({
      leadId: drB.leadId,
      actor: actor('STORE_USER'),
      assignments: [{ itemId: drB.items[0].id, sources: [{ poItemId, serialNumbers: ['ONLY-1'] }] }],
    }),
  ]);
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  assert.equal(ok, 1, 'exactly one assignment succeeds');
  const after = await prisma.storePurchaseOrderItem.findUnique({ where: { id: poItemId } });
  assert.equal(after.serialNumbers.length, 0, 'the single serial is consumed once');
});

// ── Stage 15: agreement close-out ────────────────────────────────────────────
test('verifyAgreement requires the signed agreement doc, else 400', async () => {
  const lead = await createLead({ status: 'AGREEMENT_PENDING' });
  await rejectsWithStatus(() => sm.verifyAgreement({ leadId: lead.id, actor: actor('SOFTWARE_USER') }), 400);
});

test('markAgreementSentForSignature → AGREEMENT_SENT_FOR_SIGNATURE with a timestamp', async () => {
  const lead = await createLead({ status: 'AGREEMENT_PENDING' });
  const updated = await sm.markAgreementSentForSignature({
    leadId: lead.id,
    actor: actor('SOFTWARE_USER'),
  });
  assert.equal(updated.status, 'AGREEMENT_SENT_FOR_SIGNATURE');
  assert.ok(updated.agreementSentForSignatureAt, 'stamps when it was sent');
});

test('markAgreementSentForSignature from a wrong status → 409', async () => {
  const lead = await createLead({ status: 'CLIENT_HANDOVER_PENDING' });
  await rejectsWithStatus(
    () => sm.markAgreementSentForSignature({ leadId: lead.id, actor: actor('SOFTWARE_USER') }),
    409,
  );
});

test('verifyAgreement also completes from AGREEMENT_SENT_FOR_SIGNATURE (guided, not gated)', async () => {
  const lead = await createLead({ status: 'AGREEMENT_PENDING' });
  await sm.markAgreementSentForSignature({ leadId: lead.id, actor: actor('SOFTWARE_USER') });
  await addRequiredDocs(lead.id, 'ISP');
  await addDocument(lead.id, 'AGREEMENT');
  const updated = await sm.verifyAgreement({ leadId: lead.id, actor: actor('SOFTWARE_USER') });
  assert.equal(updated.status, 'COMPLETED');
});

// Docs are optional at upload, but the agreement close-out enforces the full
// per-category required list — the lead cannot COMPLETE with gaps.
test('verifyAgreement blocks while required documents are missing → 400 naming them', async () => {
  const lead = await createLead({ status: 'AGREEMENT_PENDING' }); // ISP default
  await addDocument(lead.id, 'AGREEMENT'); // signed copy present, required list not
  try {
    await sm.verifyAgreement({ leadId: lead.id, actor: actor('SOFTWARE_USER') });
    assert.fail('should have thrown');
  } catch (e) {
    assert.equal(e.status, 400);
    assert.match(e.message, /Copy of ISP License/);
  }
  assert.notEqual(await status(lead.id), 'COMPLETED');
});

test('verifyAgreement completes once every required doc + the agreement exist', async () => {
  const lead = await createLead({ status: 'AGREEMENT_PENDING' });
  await addRequiredDocs(lead.id, 'ISP');
  await addDocument(lead.id, 'AGREEMENT');
  const updated = await sm.verifyAgreement({ leadId: lead.id, actor: actor('SOFTWARE_USER') });
  assert.equal(updated.status, 'COMPLETED');
});

// ── Full lifecycle: every transition's happy path, in order ──────────────────
test('a lead walks the full pipeline NEW → COMPLETED', async () => {
  // Non-ISP so the walk covers ALL 15 stages (ISP skips NOC L3 + the L3→L2
  // handoff — covered by its own tests).
  const lead = await createLead({
    status: 'APPROVED',
    category: 'PIN_RATE',
    requirementDetails: { estimatedUserCount: 100, ratePerUser: 40 },
  });
  await addApprovedDocument(lead.id, 'PAN');

  await sm.submitDocsForVerification({ leadId: lead.id, actor: actor('SALES_USER') });
  assert.equal(await status(lead.id), 'DOCS_UPLOADED');

  await sm.completeDocs({ leadId: lead.id, actor: actor('SOFTWARE_USER') });
  assert.equal(await status(lead.id), 'DELIVERY_REQ_PENDING');

  const pipeProduct = await createProduct();
  await sm.submitMaterialReq({ leadId: lead.id, actor: actor('DELIVERY_USER'), items: [{ productId: pipeProduct.id, quantity: 1 }] });
  assert.equal(await status(lead.id), 'MATERIAL_APPROVAL_PENDING');

  await sm.approveMaterialRequest({ leadId: lead.id, actor: actor('ADMIN') });
  assert.equal(await status(lead.id), 'AWAITING_DISPATCH');

  // Store stocks the product, then assigns it to the request.
  const pipeStock = await createStock({ productId: pipeProduct.id, serialNumbers: ['S1'] });
  const pipeDr = await prisma.deliveryRequest.findUnique({ where: { leadId: lead.id }, include: { items: true } });
  await sm.assignMaterial({
    leadId: lead.id,
    actor: actor('STORE_USER'),
    assignments: [{ itemId: pipeDr.items[0].id, sources: [{ poItemId: pipeStock.items[0].id, serialNumbers: ['S1'] }] }],
  });
  assert.equal(await status(lead.id), 'DISPATCHED');

  await sm.completeInstallation({ leadId: lead.id, actor: actor('DELIVERY_USER'), notes: 'done' });
  assert.equal(await status(lead.id), 'NOC_L2_PENDING');

  await sm.completeNocL2({ leadId: lead.id, actor: actor('NOC_L2_USER'), configNotes: 'vlan set' });
  assert.equal(await status(lead.id), 'AGGREGATOR_CONFIRM_PENDING');

  await sm.confirmAggregator({ leadId: lead.id, actor: actor('SALES_USER'), aggregatorType: 'BNG', remark: 'ok' });
  assert.equal(await status(lead.id), 'SOFTWARE_PENDING');

  await sm.completeSoftware({ leadId: lead.id, actor: actor('SOFTWARE_USER'), managedBy: 'SOFTWARE', portalUsername: 'acme' });
  assert.equal(await status(lead.id), 'NOC_L3_PENDING');

  await sm.completeNocL3({ leadId: lead.id, actor: actor('NOC_L3_USER'), ipAllocation: { subnet: '10.0.0.0/24' } });
  assert.equal(await status(lead.id), 'L3_TO_L2_HANDOFF');

  await sm.completeL3ToL2({ leadId: lead.id, actor: actor('NOC_L2_USER'), notes: 'assigned' });
  assert.equal(await status(lead.id), 'CLIENT_HANDOVER_PENDING');

  await sm.completeClientHandover({ leadId: lead.id, actor: actor('SALES_USER'), notes: 'handed over' });
  assert.equal(await status(lead.id), 'AGREEMENT_PENDING');

  // Close-out demands the category's full required-docs list + the agreement.
  await addRequiredDocs(lead.id, 'PIN_RATE');
  await addDocument(lead.id, 'AGREEMENT');
  await sm.verifyAgreement({ leadId: lead.id, actor: actor('SOFTWARE_USER') });
  assert.equal(await status(lead.id), 'COMPLETED');
});

// ── Concurrency regression: the fix from the audit ──────────────────────────
test('two concurrent transitions on one lead: exactly one wins, one 409, single log row', async () => {
  const lead = await createLead(); // NEW

  const results = await Promise.allSettled([
    sm.submitForFeasibility({ leadId: lead.id, actor: actor('SALES_USER') }),
    sm.submitForFeasibility({ leadId: lead.id, actor: actor('SALES_USER') }),
  ]);

  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'exactly one transition succeeds');
  assert.equal(rejected.length, 1, 'exactly one transition is rejected');
  assert.equal(rejected[0].reason.status, 409, 'the loser gets a 409');

  assert.equal(await status(lead.id), 'FEASIBILITY_PENDING');

  // No duplicate audit row — the heart of the concurrency fix.
  const logs = await prisma.statusChangeLog.count({
    where: { entityType: 'Lead', entityId: lead.id, newValue: 'FEASIBILITY_PENDING' },
  });
  assert.equal(logs, 1, 'only one status-change log row written');
});

// ── Stage 10: aggregator types — BGP is an ISP-only option ───────────────────
test('confirmAggregator accepts BGP for an ISP lead', async () => {
  const lead = await createLead({ status: 'AGGREGATOR_CONFIRM_PENDING' }); // helper default = ISP
  const updated = await sm.confirmAggregator({
    leadId: lead.id,
    actor: actor('SALES_USER'),
    aggregatorType: 'BGP',
    remark: 'BGP session with client AS',
  });
  assert.equal(updated.aggregatorType, 'BGP');
  assert.equal(updated.status, 'SOFTWARE_PENDING');
});

test('confirmAggregator rejects BGP for a non-ISP lead → 400', async () => {
  const lead = await createLead({
    status: 'AGGREGATOR_CONFIRM_PENDING',
    category: 'PIN_RATE',
    requirementDetails: { estimatedUserCount: 100, ratePerUser: 40 },
  });
  await rejectsWithStatus(
    () => sm.confirmAggregator({ leadId: lead.id, actor: actor('SALES_USER'), aggregatorType: 'BGP', remark: 'x' }),
    400,
  );
});

test('confirmAggregator rejects an unknown aggregator type → 400', async () => {
  const lead = await createLead({ status: 'AGGREGATOR_CONFIRM_PENDING' });
  await rejectsWithStatus(
    () => sm.confirmAggregator({ leadId: lead.id, actor: actor('SALES_USER'), aggregatorType: 'CISCO', remark: 'x' }),
    400,
  );
});

// ── ISP shortcut: no NOC L3, no L3→L2 handoff ────────────────────────────────
test('completeSoftware on an ISP lead skips NOC L3 + handoff → CLIENT_HANDOVER_PENDING', async () => {
  const lead = await createLead({ status: 'SOFTWARE_PENDING' }); // helper default = ISP
  const updated = await sm.completeSoftware({ leadId: lead.id, actor: actor('SOFTWARE_USER'), managedBy: 'SOFTWARE', portalUsername: 'ispco' });
  assert.equal(updated.status, 'CLIENT_HANDOVER_PENDING');
});

test('completeSoftware on a non-ISP lead still goes to NOC L3', async () => {
  const lead = await createLead({
    status: 'SOFTWARE_PENDING',
    category: 'PIN_RATE',
    requirementDetails: { estimatedUserCount: 100, ratePerUser: 40 },
  });
  const updated = await sm.completeSoftware({ leadId: lead.id, actor: actor('SOFTWARE_USER'), managedBy: 'SOFTWARE', portalUsername: 'pinco' });
  assert.equal(updated.status, 'NOC_L3_PENDING');
});

// ── Stage 11: portal "Managed by" — ISP-managed portals carry no credentials ──
test('completeSoftware managed by SOFTWARE stores the portal credentials', async () => {
  const lead = await createLead({
    status: 'SOFTWARE_PENDING',
    category: 'PIN_RATE',
    requirementDetails: { estimatedUserCount: 100, ratePerUser: 40 },
  });
  const updated = await sm.completeSoftware({
    leadId: lead.id,
    actor: actor('SOFTWARE_USER'),
    managedBy: 'SOFTWARE',
    portalUsername: 'acme',
    portalUrl: 'https://portal.acme.test',
    portalPassword: 's3cret',
  });
  assert.equal(updated.portalManagedBy, 'SOFTWARE');
  assert.equal(updated.portalUsername, 'acme');
  assert.equal(updated.portalPassword, 's3cret');
});

test('completeSoftware managed by ISP never stores credentials, even if sent', async () => {
  const lead = await createLead({
    status: 'SOFTWARE_PENDING',
    category: 'PIN_RATE',
    requirementDetails: { estimatedUserCount: 100, ratePerUser: 40 },
  });
  const updated = await sm.completeSoftware({
    leadId: lead.id,
    actor: actor('SOFTWARE_USER'),
    managedBy: 'ISP',
    portalUsername: 'should-be-dropped',
    portalPassword: 'should-be-dropped',
  });
  assert.equal(updated.portalManagedBy, 'ISP');
  assert.equal(updated.portalUsername, null);
  assert.equal(updated.portalUrl, null);
  assert.equal(updated.portalPassword, null);
  assert.equal(updated.status, 'NOC_L3_PENDING');
});

test('completeSoftware requires a valid managedBy → 400', async () => {
  const lead = await createLead({ status: 'SOFTWARE_PENDING' });
  await rejectsWithStatus(
    () => sm.completeSoftware({ leadId: lead.id, actor: actor('SOFTWARE_USER'), portalUsername: 'x' }),
    400,
  );
  await rejectsWithStatus(
    () => sm.completeSoftware({ leadId: lead.id, actor: actor('SOFTWARE_USER'), managedBy: 'VENDOR' }),
    400,
  );
});

// ── Stage 6: some leads need no material at all ──────────────────────────────
test('skipMaterialReq jumps straight to the installation queue (DISPATCHED)', async () => {
  const lead = await createLead({ status: 'DELIVERY_REQ_PENDING' });
  const updated = await sm.skipMaterialReq({
    leadId: lead.id,
    actor: actor('DELIVERY_USER'),
    reason: 'Config-only job, existing hardware',
  });
  assert.equal(updated.status, 'DISPATCHED');
  const notes = await prisma.leadNote.findMany({ where: { leadId: lead.id, stage: 'DELIVERY' } });
  assert.ok(notes.some((n) => n.body.includes('Material not required')), 'skip reason recorded');
});

test('skipMaterialReq from a wrong status → 409', async () => {
  const lead = await createLead({ status: 'AWAITING_DISPATCH' });
  await rejectsWithStatus(
    () => sm.skipMaterialReq({ leadId: lead.id, actor: actor('DELIVERY_USER'), reason: '' }),
    409,
  );
});
