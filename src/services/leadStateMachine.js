import { Prisma } from '@prisma/client';
import prisma from '../config/db.js';
import { logStatusChange } from './statusChangeLog.service.js';
import { addLeadNote } from './leadNote.service.js';
import { notifyRoles, notifyOneUser, refreshSidebarForRoles } from './notification.service.js';
import { assertLeadAccess } from '../utils/leadAccess.js';
import { hasAccess } from '../utils/roleHelper.js';
import { AGREEMENT_DOC_TYPE } from '../utils/documentTypes.js';
import { missingRequiredDocs } from '../utils/docRequirements.js';
import { generateDeliveryRequestNumber } from './leadNumber.service.js';
import { KNOWN_AGGREGATORS, BNG_CLASS, requiredKeysFor } from '../utils/nocL3Fields.js';

// Append to a delivery request's audit trail. Soft-fail — never break the flow.
const logDeliveryRequest = async ({ deliveryRequestId, action, actor, details = null }) => {
  try {
    await prisma.deliveryRequestLog.create({
      data: { deliveryRequestId, action, performedById: actor.id, details },
    });
  } catch (err) {
    console.warn('[logDeliveryRequest]', err?.message);
  }
};

/**
 * LeadStateMachine — the single place lead stage transitions happen (CLAUDE.md §9).
 * Each transition: precondition (status + role enforced at the route) → update →
 * audit (soft-fail) → notify next role + refresh outgoing sidebars (soft-fail).
 *
 * Throws an Error carrying `.status` (HTTP code) on a precondition violation; the
 * controller maps that to a response.
 */

const ADMIN_ROLES = ['SUPER_ADMIN', 'ADMIN'];
const withCreator = { include: { createdBy: { select: { id: true, name: true } } } };

const httpError = (status, message) => Object.assign(new Error(message), { status });

const loadLead = async (leadId) => {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) throw httpError(404, 'Lead not found.');
  return lead;
};

const salesOwner = (lead) => lead.assignedSalesId || lead.createdById;

/**
 * Atomically apply a stage transition. A conditional `updateMany` (status = from)
 * means only the request that actually observes the lead in `from` mutates it —
 * a double-submit or two concurrent actors can't both pass the precondition and
 * fire duplicate notifications/log rows. The loser gets a 409. `data` must carry
 * the new `status`. Returns the updated lead (with creator), matching a normal
 * `prisma.lead.update`. Optionally runs inside a caller-supplied tx client.
 */
const applyTransition = async (leadId, from, data, client = prisma) => {
  const { count } = await client.lead.updateMany({ where: { id: leadId, status: from }, data });
  if (count === 0) {
    const current = await client.lead.findUnique({ where: { id: leadId }, select: { status: true } });
    if (!current) throw httpError(404, 'Lead not found.');
    throw httpError(409, 'This lead has already moved to a later stage. Refresh to see where it is now.');
  }
  return client.lead.findUnique({ where: { id: leadId }, ...withCreator });
};

// Append a free-text note to the lead's pipelineNotes JSON array (for stages
// without a dedicated notes column). Returns the new array, or the existing one
// unchanged when there's no note.
const appendNote = (lead, stage, note, actor) => {
  const arr = Array.isArray(lead.pipelineNotes) ? lead.pipelineNotes : [];
  if (!note || !String(note).trim()) return arr;
  return [...arr, { stage, note, by: actor.id, at: new Date().toISOString() }];
};

// Stage 1 → 2: sales submits a NEW lead into the feasibility pool.
export const submitForFeasibility = async ({ leadId, actor }) => {
  const lead = await loadLead(leadId);
  assertLeadAccess(actor, lead); // sales user must own the lead
  if (lead.status !== 'NEW') {
    throw httpError(409, 'This lead has already been submitted for feasibility.');
  }

  const updated = await applyTransition(leadId, 'NEW', { status: 'FEASIBILITY_PENDING' });

  await logStatusChange({
    entityType: 'Lead',
    entityId: leadId,
    oldValue: lead.status,
    newValue: 'FEASIBILITY_PENDING',
    actor,
  });
  await notifyRoles(['FEASIBILITY_USER'], {
    type: 'STAGE_TRANSITION',
    title: `${lead.leadNumber} awaiting feasibility`,
    message: lead.organizationName,
    leadId,
  });
  await refreshSidebarForRoles(ADMIN_ROLES);
  return updated;
};

// Resolve feasibility fiber segments: confirm each referenced Vendor exists and
// snapshot its name/type into the stored JSON (so display survives later
// renames/deletes). `segments` is the validated array from
// validation/feasibilityVendors. Throws 400 on an empty list or missing vendor.
const resolveVendorSegments = async (segments) => {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw httpError(400, 'Add at least one fiber segment when marking a lead feasible.');
  }
  const vendorIds = [...new Set(segments.filter((s) => s.kind === 'VENDOR').map((s) => s.vendorId))];
  const found = vendorIds.length
    ? await prisma.vendor.findMany({
        where: { id: { in: vendorIds } },
        select: { id: true, name: true, type: true },
      })
    : [];
  const byId = new Map(found.map((v) => [v.id, v]));
  for (const id of vendorIds) {
    if (!byId.has(id)) throw httpError(400, 'One of the selected vendors no longer exists.');
  }
  return segments.map((s) => {
    const base = { kind: s.kind, fiberMeters: s.fiberMeters, ...(s.path ? { path: s.path } : {}) };
    if (s.kind === 'VENDOR') {
      const v = byId.get(s.vendorId);
      return { ...base, vendorId: v.id, vendorName: v.name, vendorType: v.type };
    }
    // Client Fiber is free-text — store the client name as the user typed it.
    if (s.kind === 'CLIENT') {
      return { ...base, clientName: s.clientName };
    }
    return base;
  });
};

// Stage 2: feasibility decides. Feasible → pricing pool; not feasible → REJECTED.
// On the feasible path the reviewer may also attach a POP and set/correct the
// lead's original coordinates.
export const completeFeasibility = async ({
  leadId,
  actor,
  feasible,
  notes,
  vendors,
  popIds = [],
  latitude,
  longitude,
  networkType,
  offNet,
  estimatedDeliveryAt,
}) => {
  const lead = await loadLead(leadId);
  if (lead.status !== 'FEASIBILITY_PENDING') {
    throw httpError(409, 'This lead is no longer awaiting feasibility — someone already reviewed it.');
  }
  if (!feasible && !String(notes || '').trim()) {
    throw httpError(400, 'A reason is required when marking a lead not feasible.');
  }

  // Resolve every selected POP → confirm it exists and snapshot it (so display
  // survives later POP renames/deletes). Preserve the selection order.
  let popSnapshots = [];
  if (popIds.length) {
    const uniqueIds = [...new Set(popIds)];
    const found = await prisma.popLocation.findMany({
      where: { id: { in: uniqueIds } },
      select: { id: true, name: true, latitude: true, longitude: true },
    });
    if (found.length !== uniqueIds.length) throw httpError(400, 'A selected POP location no longer exists.');
    const byId = Object.fromEntries(found.map((p) => [p.id, p]));
    popSnapshots = uniqueIds.map((id) => byId[id]);
  }
  const primaryPopId = popSnapshots[0]?.id ?? null;

  // On the feasible path, resolve vendor segments: confirm each referenced
  // Vendor exists and snapshot its name/type into the stored JSON so display
  // survives later renames/deletes.
  const feasibilityVendors = feasible ? await resolveVendorSegments(vendors) : null;

  const newStatus = feasible ? 'PRICING_PENDING' : 'REJECTED';
  const updated = await applyTransition(leadId, 'FEASIBILITY_PENDING', {
    status: newStatus,
    feasibilityAssignedToId: actor.id,
    feasibilityNotes: notes ?? null,
    feasibilityReviewedAt: new Date(),
    ...(networkType !== undefined ? { feasibilityNetworkType: networkType } : {}),
    // Off-net BTS details apply whenever they were captured (either outcome).
    ...(offNet !== undefined ? { feasibilityOffNet: offNet } : {}),
    // POP + coordinate edits only apply on the feasible path.
    ...(feasible
      ? {
          feasibilityVendors,
          feasibilityPops: popSnapshots,
          popLocationId: primaryPopId,
          ...(latitude !== undefined ? { latitude } : {}),
          ...(longitude !== undefined ? { longitude } : {}),
          ...(estimatedDeliveryAt !== undefined ? { estimatedDeliveryAt } : {}),
        }
      : { rejectedReason: notes }),
  });

  await addLeadNote({
    leadId,
    stage: 'FEASIBILITY',
    body: feasible ? notes : `Not feasible: ${notes}`,
    actor,
  });
  await logStatusChange({
    entityType: 'Lead',
    entityId: leadId,
    oldValue: lead.status,
    newValue: newStatus,
    actor,
    reason: feasible ? notes || null : `Not feasible: ${notes}`,
  });

  if (feasible) {
    // Pricing queue is owner-scoped — notify the lead's owner, not all of sales.
    await notifyOneUser(salesOwner(lead), {
      type: 'STAGE_TRANSITION',
      title: `${lead.leadNumber} ready for pricing`,
      message: lead.organizationName,
      leadId,
    });
  } else {
    await notifyOneUser(salesOwner(lead), {
      type: 'STAGE_TRANSITION',
      title: `${lead.leadNumber} rejected at feasibility`,
      message: notes,
      leadId,
    });
  }
  await refreshSidebarForRoles(['FEASIBILITY_USER', ...ADMIN_ROLES]);
  return updated;
};

// Stage 3: sales submits pricing → approval queue.
export const submitPricing = async ({ leadId, actor, pricing }) => {
  const lead = await loadLead(leadId);
  assertLeadAccess(actor, lead); // sales user must own the lead
  if (lead.status !== 'PRICING_PENDING') {
    throw httpError(409, 'This lead is not currently awaiting pricing. Refresh to see where it is now.');
  }

  const updated = await applyTransition(leadId, 'PRICING_PENDING', {
    status: 'PENDING_APPROVAL',
    pricing,
    assignedSalesId: lead.assignedSalesId || actor.id,
    pricingRevisionReason: null, // clear any prior send-back note on resubmit
  });

  await addLeadNote({ leadId, stage: 'PRICING', body: pricing?.notes, actor });
  await logStatusChange({
    entityType: 'Lead',
    entityId: leadId,
    oldValue: lead.status,
    newValue: 'PENDING_APPROVAL',
    actor,
  });
  await notifyRoles(ADMIN_ROLES, {
    type: 'STAGE_TRANSITION',
    title: `${lead.leadNumber} pending approval`,
    message: lead.organizationName,
    leadId,
  });
  await refreshSidebarForRoles(['SALES_USER']);
  return updated;
};

// Stage 4: admin approves.
export const approveLead = async ({ leadId, actor, notes }) => {
  const lead = await loadLead(leadId);
  if (lead.status !== 'PENDING_APPROVAL') {
    throw httpError(409, 'This lead is not currently awaiting approval. Refresh to see where it is now.');
  }

  const updated = await applyTransition(leadId, 'PENDING_APPROVAL', {
    status: 'APPROVED',
    approvedById: actor.id,
    approvedAt: new Date(),
    approvalNotes: String(notes || '').trim() || null,
  });

  await addLeadNote({ leadId, stage: 'APPROVAL', body: notes, actor });
  await logStatusChange({
    entityType: 'Lead',
    entityId: leadId,
    oldValue: lead.status,
    newValue: 'APPROVED',
    actor,
  });
  await notifyOneUser(salesOwner(lead), {
    type: 'STAGE_TRANSITION',
    title: `${lead.leadNumber} approved`,
    message: lead.organizationName,
    leadId,
  });
  await refreshSidebarForRoles(ADMIN_ROLES);
  return updated;
};

// Stage 4: admin rejects the pricing → sends the lead BACK to sales to revise
// (not a terminal reject). Reason required; surfaced to sales on the pricing form.
export const rejectLead = async ({ leadId, actor, reason }) => {
  const lead = await loadLead(leadId);
  if (lead.status !== 'PENDING_APPROVAL') {
    throw httpError(409, 'This lead is not currently awaiting approval. Refresh to see where it is now.');
  }
  if (!String(reason || '').trim()) {
    throw httpError(400, 'A reason is required to send a lead back for revision.');
  }

  const updated = await applyTransition(leadId, 'PENDING_APPROVAL', {
    status: 'PRICING_PENDING',
    pricingRevisionReason: reason,
    pricingRevisionCount: { increment: 1 },
  });

  await addLeadNote({ leadId, stage: 'APPROVAL', body: `Sent back to revise: ${reason}`, actor });
  await logStatusChange({
    entityType: 'Lead',
    entityId: leadId,
    oldValue: lead.status,
    newValue: 'PRICING_PENDING',
    actor,
    reason: `Sent back for pricing revision: ${reason}`,
  });
  await notifyOneUser(salesOwner(lead), {
    type: 'STAGE_TRANSITION',
    title: `${lead.leadNumber} pricing sent back for revision`,
    message: reason,
    leadId,
  });
  await refreshSidebarForRoles([...ADMIN_ROLES, 'SALES_USER']);
  return updated;
};

// Stage 5a: sales finishes uploading (≥1 doc) → sends the lead to the SOFTWARE
// docs-verification step. Approval of individual docs happens there, not here.
export const submitDocsForVerification = async ({ leadId, actor }) => {
  const lead = await loadLead(leadId);
  assertLeadAccess(actor, lead); // sales user must own the lead
  if (lead.status !== 'APPROVED') {
    throw httpError(409, 'This lead is not currently at the docs-upload stage. Refresh to see where it is now.');
  }
  // Documents are OPTIONAL at this stage — the full required list is enforced
  // at the agreement close-out (see verifyAgreement).
  const updated = await applyTransition(leadId, 'APPROVED', { status: 'DOCS_UPLOADED' });
  await logStatusChange({
    entityType: 'Lead',
    entityId: leadId,
    oldValue: lead.status,
    newValue: 'DOCS_UPLOADED',
    actor,
  });
  await notifyRoles(['SOFTWARE_USER'], {
    type: 'STAGE_TRANSITION',
    title: `${lead.leadNumber} docs uploaded — verify`,
    message: lead.organizationName,
    leadId,
  });
  await refreshSidebarForRoles(['SALES_USER', 'SOFTWARE_USER', ...ADMIN_ROLES]);
  return updated;
};

// Stage 5b: SOFTWARE verifies (approves) every uploaded doc → delivery queue.
export const completeDocs = async ({ leadId, actor }) => {
  const lead = await loadLead(leadId);
  assertLeadAccess(actor, lead); // software (stage role) or admins
  if (lead.status !== 'DOCS_UPLOADED') {
    throw httpError(409, 'This lead is not currently awaiting docs verification. Refresh to see where it is now.');
  }

  // Lock the lead row and re-check the docs INSIDE the transaction, so a
  // concurrent (un)approval can't slip between the check and the transition
  // (the approval endpoint takes the same lock — see setDocumentSalesApproval).
  const updated = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Lead" WHERE id = ${leadId} FOR UPDATE`;
    const docs = await tx.leadDocument.findMany({
      where: { leadId },
      select: { salesApprovedAt: true, verificationStatus: true },
    });
    // Every uploaded doc must be approved AND not left in a REJECTED state
    // (defense in depth — rejecting a doc already clears its approval).
    if (docs.some((d) => !d.salesApprovedAt || d.verificationStatus === 'REJECTED')) {
      throw httpError(400, 'Verify (approve) all uploaded documents before completing this stage.');
    }
    // Rejection happens BEFORE delivery (stage 5b), so completion always
    // continues down the normal pipeline; any revision reason is now resolved.
    return applyTransition(leadId, 'DOCS_UPLOADED', { status: 'DELIVERY_REQ_PENDING', docsRevisionReason: null }, tx);
  });
  const nextStatus = 'DELIVERY_REQ_PENDING';

  await logStatusChange({
    entityType: 'Lead',
    entityId: leadId,
    oldValue: lead.status,
    newValue: nextStatus,
    actor,
  });
  await notifyRoles(['DELIVERY_USER'], {
    type: 'STAGE_TRANSITION',
    title: `${lead.leadNumber} ready for delivery`,
    message: lead.organizationName,
    leadId,
  });
  await refreshSidebarForRoles(['SALES_USER', 'SOFTWARE_USER', 'DELIVERY_USER', ...ADMIN_ROLES]);
  return updated;
};

// Stage 5b → 5a: software rejects an uploaded document at the docs-verify
// stage → the lead goes BACK to the sales upload stage with a reason (not
// terminal). Sales fixes the file and re-sends for verification.
export const rejectDocs = async ({ leadId, actor, reason }) => {
  const lead = await loadLead(leadId);
  if (lead.status !== 'DOCS_UPLOADED') {
    throw httpError(409, 'Documents can only be rejected while the lead is awaiting docs verification.');
  }
  if (!String(reason || '').trim()) {
    throw httpError(400, 'A reason is required to reject a document.');
  }

  const updated = await applyTransition(leadId, 'DOCS_UPLOADED', {
    status: 'APPROVED',
    docsRevisionReason: reason,
    docsRevisionCount: { increment: 1 },
  });

  await addLeadNote({ leadId, stage: 'SOFTWARE', body: `Docs rejected: ${reason}`, actor });
  await logStatusChange({
    entityType: 'Lead',
    entityId: leadId,
    oldValue: lead.status,
    newValue: 'APPROVED',
    actor,
    reason: `Docs rejected: ${reason}`,
  });
  await notifyOneUser(salesOwner(lead), {
    type: 'STAGE_TRANSITION',
    title: `${lead.leadNumber} docs rejected — re-upload needed`,
    message: reason,
    leadId,
  });
  await refreshSidebarForRoles(['SOFTWARE_USER', 'SALES_USER', ...ADMIN_ROLES]);
  return updated;
};

// Stage 6: delivery submits material requisition → store queue.
// Stage 6: delivery raises a catalog-driven material request → admin approval.
// Reuses the lead's single DeliveryRequest (1:1) — a resubmit after rejection
// replaces its items and returns it to PENDING_APPROVAL rather than duplicating.
// Stage 6 shortcut: some jobs need no material at all (config-only, client
// hardware). Skip requisition → approval → dispatch and land the lead straight
// in the installation queue, with the reason on the timeline.
export const skipMaterialReq = async ({ leadId, actor, reason }) => {
  const lead = await loadLead(leadId);
  if (lead.status !== 'DELIVERY_REQ_PENDING') {
    throw httpError(409, 'This lead is not currently awaiting a material request. Refresh to see where it is now.');
  }

  const updated = await applyTransition(leadId, 'DELIVERY_REQ_PENDING', { status: 'DISPATCHED' });

  const note = `Material not required${String(reason || '').trim() ? ` — ${String(reason).trim()}` : ''}`;
  await addLeadNote({ leadId, stage: 'DELIVERY', body: note, actor });
  await logStatusChange({
    entityType: 'Lead',
    entityId: leadId,
    oldValue: lead.status,
    newValue: 'DISPATCHED',
    actor,
    reason: note,
  });
  // Skipping material sends the lead straight to installation — tell delivery.
  await notifyRoles(['DELIVERY_USER'], {
    type: 'STAGE_TRANSITION',
    title: `${lead.leadNumber} ready for installation`,
    message: lead.organizationName,
    leadId,
  });
  await refreshSidebarForRoles(['DELIVERY_USER', 'STORE_USER', ...ADMIN_ROLES]);
  return updated;
};

export const submitMaterialReq = async ({ leadId, actor, items, deliveryAddress, notes, urgency }) => {
  const lead = await loadLead(leadId);
  if (lead.status !== 'DELIVERY_REQ_PENDING') {
    throw httpError(409, 'This lead is not currently awaiting a material request. Refresh to see where it is now.');
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw httpError(400, 'Add at least one product to the material request.');
  }
  // Confirm every referenced product exists (FK would 500 otherwise).
  const productIds = [...new Set(items.map((i) => i.productId))];
  const found = await prisma.storeProduct.count({ where: { id: { in: productIds } } });
  if (found !== productIds.length) throw httpError(400, 'One or more products no longer exist.');

  const { updated, drId } = await prisma.$transaction(async (tx) => {
    const moved = await applyTransition(leadId, 'DELIVERY_REQ_PENDING', { status: 'MATERIAL_APPROVAL_PENDING' }, tx);
    const existing = await tx.deliveryRequest.findUnique({ where: { leadId }, select: { id: true } });
    let dr;
    if (existing) {
      // Resubmit: clear prior items + rejection, back to PENDING_APPROVAL.
      await tx.deliveryRequestItem.deleteMany({ where: { deliveryRequestId: existing.id } });
      dr = await tx.deliveryRequest.update({
        where: { id: existing.id },
        data: {
          status: 'PENDING_APPROVAL',
          deliveryAddress: deliveryAddress ?? null,
          notes: notes ?? null,
          urgency: urgency ?? null,
          superAdminRejectedById: null,
          superAdminRejectedAt: null,
          superAdminRejectionReason: null,
          items: { create: items.map((i) => ({ productId: i.productId, quantity: i.quantity })) },
        },
      });
    } else {
      const requestNumber = await generateDeliveryRequestNumber(tx);
      dr = await tx.deliveryRequest.create({
        data: {
          requestNumber,
          leadId,
          requestedById: actor.id,
          deliveryAddress: deliveryAddress ?? null,
          notes: notes ?? null,
          urgency: urgency ?? null,
          items: { create: items.map((i) => ({ productId: i.productId, quantity: i.quantity })) },
        },
      });
    }
    return { updated: moved, drId: dr.id };
  });

  await logDeliveryRequest({ deliveryRequestId: drId, action: 'CREATED', actor, details: { items } });
  await addLeadNote({ leadId, stage: 'DELIVERY', body: notes, actor });
  await logStatusChange({
    entityType: 'Lead',
    entityId: leadId,
    oldValue: lead.status,
    newValue: 'MATERIAL_APPROVAL_PENDING',
    actor,
  });
  await notifyRoles(ADMIN_ROLES, {
    type: 'STAGE_TRANSITION',
    title: `${lead.leadNumber} material request needs approval`,
    message: lead.organizationName,
    leadId,
  });
  await refreshSidebarForRoles(['DELIVERY_USER', ...ADMIN_ROLES]);
  return updated;
};

// Stage 6b: admin approves the material list → store dispatch queue.
export const approveMaterialRequest = async ({ leadId, actor }) => {
  const lead = await loadLead(leadId);
  if (lead.status !== 'MATERIAL_APPROVAL_PENDING') {
    throw httpError(409, 'This lead is not currently awaiting material approval. Refresh to see where it is now.');
  }
  const dr = await prisma.deliveryRequest.findUnique({ where: { leadId }, select: { id: true, requestedById: true } });

  const updated = await prisma.$transaction(async (tx) => {
    const moved = await applyTransition(leadId, 'MATERIAL_APPROVAL_PENDING', { status: 'AWAITING_DISPATCH' }, tx);
    if (dr) {
      await tx.deliveryRequest.update({
        where: { id: dr.id },
        data: { status: 'APPROVED', superAdminApprovedById: actor.id, superAdminApprovedAt: new Date() },
      });
    }
    return moved;
  });

  if (dr) await logDeliveryRequest({ deliveryRequestId: dr.id, action: 'APPROVED', actor });
  await logStatusChange({
    entityType: 'Lead',
    entityId: leadId,
    oldValue: lead.status,
    newValue: 'AWAITING_DISPATCH',
    actor,
  });
  await notifyRoles(['STORE_USER'], {
    type: 'STAGE_TRANSITION',
    title: `${lead.leadNumber} awaiting dispatch`,
    message: lead.organizationName,
    leadId,
  });
  // Tell the delivery user who raised the request that it was approved
  // (mirrors the reject path, which already notifies them).
  if (dr?.requestedById) {
    await notifyOneUser(dr.requestedById, {
      type: 'STAGE_TRANSITION',
      title: `${lead.leadNumber} material request approved`,
      message: lead.organizationName,
      leadId,
    });
  }
  await refreshSidebarForRoles(['STORE_USER', 'DELIVERY_USER', ...ADMIN_ROLES]);
  return updated;
};

// Stage 6b: admin rejects the material list → back to delivery to revise.
export const rejectMaterialRequest = async ({ leadId, actor, reason }) => {
  const lead = await loadLead(leadId);
  if (lead.status !== 'MATERIAL_APPROVAL_PENDING') {
    throw httpError(409, 'This lead is not currently awaiting material approval. Refresh to see where it is now.');
  }
  if (!String(reason || '').trim()) {
    throw httpError(400, 'A reason is required to reject a material request.');
  }
  const dr = await prisma.deliveryRequest.findUnique({ where: { leadId }, select: { id: true, requestedById: true } });

  const updated = await prisma.$transaction(async (tx) => {
    const moved = await applyTransition(leadId, 'MATERIAL_APPROVAL_PENDING', { status: 'DELIVERY_REQ_PENDING' }, tx);
    if (dr) {
      await tx.deliveryRequest.update({
        where: { id: dr.id },
        data: {
          status: 'REJECTED',
          superAdminRejectedById: actor.id,
          superAdminRejectedAt: new Date(),
          superAdminRejectionReason: reason,
        },
      });
    }
    return moved;
  });

  if (dr) await logDeliveryRequest({ deliveryRequestId: dr.id, action: 'REJECTED', actor, details: { reason } });
  await addLeadNote({ leadId, stage: 'DELIVERY', body: `Material request rejected: ${reason}`, actor });
  await logStatusChange({
    entityType: 'Lead',
    entityId: leadId,
    oldValue: lead.status,
    newValue: 'DELIVERY_REQ_PENDING',
    actor,
    reason: `Material request rejected: ${reason}`,
  });
  if (dr?.requestedById) {
    await notifyOneUser(dr.requestedById, {
      type: 'STAGE_TRANSITION',
      title: `${lead.leadNumber} material request sent back`,
      message: reason,
      leadId,
    });
  }
  await refreshSidebarForRoles(['DELIVERY_USER', ...ADMIN_ROLES]);
  return updated;
};

// Stage 7: store assigns material to the request from IN_STORE inventory, then
// the lead → DISPATCHED. `assignments` = per DeliveryRequestItem:
//   { itemId, sources: [{ poItemId, serialNumbers: [] }] }   // serialized
//   { itemId, bulk: { poItemId, quantity } }                 // bulk (mtrs)
// An item may draw serials from multiple POs. The whole read-validate-deduct is
// one transaction with row locks on the PO items so the same serial can never
// be assigned twice (inventory of record = StorePurchaseOrderItem, per the spec).
export const assignMaterial = async ({ leadId, actor, assignments }) => {
  const lead = await loadLead(leadId);
  if (lead.status !== 'AWAITING_DISPATCH') {
    throw httpError(409, 'This lead is not currently awaiting dispatch. Refresh to see where it is now.');
  }
  if (!Array.isArray(assignments) || assignments.length === 0) {
    throw httpError(400, 'Assign material to every requested item before dispatching.');
  }

  const dr = await prisma.deliveryRequest.findUnique({
    where: { leadId },
    include: { items: { include: { product: { select: { id: true, unit: true } } } } },
  });
  if (!dr) throw httpError(400, 'This lead has no material request to fulfil.');

  const byItemId = Object.fromEntries(dr.items.map((it) => [it.id, it]));
  // Every requested item must have an assignment (full fulfilment before dispatch).
  const assignedIds = new Set(assignments.map((a) => a.itemId));
  if (dr.items.some((it) => !assignedIds.has(it.id))) {
    throw httpError(400, 'Assign material to every requested item before dispatching.');
  }

  const drId = dr.id;
  const updated = await prisma.$transaction(async (tx) => {
    // Lock every source PO item row up front so concurrent assigns serialise
    // (the loser re-reads post-commit and fails the hasEvery check → 400/409).
    const poItemIds = [
      ...new Set(
        assignments.flatMap((a) => [
          ...(a.sources || []).map((s) => s.poItemId),
          ...(a.bulk ? [a.bulk.poItemId] : []),
        ]),
      ),
    ];
    if (poItemIds.length) {
      await tx.$queryRaw`SELECT id FROM "StorePurchaseOrderItem" WHERE id IN (${Prisma.join(poItemIds)}) FOR UPDATE`;
    }

    for (const a of assignments) {
      const item = byItemId[a.itemId];
      if (!item) throw httpError(400, 'An assignment refers to an item not on this request.');
      const isBulk = item.product.unit === 'mtrs';

      if (isBulk) {
        const bulk = a.bulk;
        if (!bulk || !bulk.poItemId || !bulk.quantity) throw httpError(400, 'Provide a source and quantity for the bulk item.');
        if (bulk.quantity !== item.quantity) throw httpError(400, 'Assign the full requested quantity for each item.');
        const src = await tx.storePurchaseOrderItem.findUnique({ where: { id: bulk.poItemId } });
        if (!src || src.status !== 'IN_STORE' || src.productId !== item.productId) {
          throw httpError(400, 'The chosen stock is no longer available for this product.');
        }
        if ((src.receivedQuantity ?? 0) < bulk.quantity) throw httpError(400, 'Not enough stock in the chosen source.');
        await tx.storePurchaseOrderItem.update({
          where: { id: src.id },
          data: { receivedQuantity: (src.receivedQuantity ?? 0) - bulk.quantity, quantity: (src.receivedQuantity ?? 0) - bulk.quantity },
        });
        await tx.deliveryRequestItem.update({
          where: { id: item.id },
          data: { assignedQuantity: bulk.quantity, assignedSerialNumbers: [], assignedFromPOItemId: src.id, isAssigned: true, assignedAt: new Date() },
        });
      } else {
        const sources = a.sources || [];
        const union = [...new Set(sources.flatMap((s) => (s.serialNumbers || []).map((x) => x.trim()).filter(Boolean)))];
        if (union.length !== item.quantity) {
          throw httpError(400, `Assign exactly ${item.quantity} serial number(s) for each item.`);
        }
        for (const s of sources) {
          const serials = [...new Set((s.serialNumbers || []).map((x) => x.trim()).filter(Boolean))];
          if (serials.length === 0) continue;
          const src = await tx.storePurchaseOrderItem.findUnique({ where: { id: s.poItemId } });
          if (!src || src.status !== 'IN_STORE' || src.productId !== item.productId) {
            throw httpError(400, 'The chosen stock is no longer available for this product.');
          }
          if (!serials.every((sn) => src.serialNumbers.includes(sn))) {
            throw httpError(400, 'One or more serials are no longer in stock — refresh and try again.');
          }
          const remaining = src.serialNumbers.filter((sn) => !serials.includes(sn));
          await tx.storePurchaseOrderItem.update({
            where: { id: src.id },
            data: { serialNumbers: remaining, receivedQuantity: remaining.length, quantity: remaining.length },
          });
        }
        await tx.deliveryRequestItem.update({
          where: { id: item.id },
          data: { assignedSerialNumbers: union, assignedQuantity: union.length, assignedFromPOItemId: sources[0]?.poItemId ?? null, isAssigned: true, assignedAt: new Date() },
        });
      }
    }

    await tx.deliveryRequest.update({
      where: { id: drId },
      data: { status: 'ASSIGNED', assignedToStoreManagerId: actor.id, assignedAt: new Date() },
    });
    return applyTransition(leadId, 'AWAITING_DISPATCH', { status: 'DISPATCHED' }, tx);
  });

  await logDeliveryRequest({ deliveryRequestId: drId, action: 'ITEMS_ASSIGNED', actor });
  await logStatusChange({
    entityType: 'Lead',
    entityId: leadId,
    oldValue: lead.status,
    newValue: 'DISPATCHED',
    actor,
  });
  await notifyOneUser(salesOwner(lead), {
    type: 'STAGE_TRANSITION',
    title: `${lead.leadNumber} material assigned & dispatched`,
    message: lead.organizationName,
    leadId,
  });
  // Installation is delivery's next stage — tell the team it's ready.
  await notifyRoles(['DELIVERY_USER'], {
    type: 'STAGE_TRANSITION',
    title: `${lead.leadNumber} ready for installation`,
    message: lead.organizationName,
    leadId,
  });
  await refreshSidebarForRoles(['STORE_USER', 'DELIVERY_USER', ...ADMIN_ROLES]);
  return updated;
};

// Generic transition helper for the M5 stages: precondition → update → log →
// notify next role → refresh outgoing sidebars.
const advance = async ({ leadId, actor, from, to, data, notifyRole, notifyTitle, outgoing, note, noteStage, ownerOnly }) => {
  const lead = await loadLead(leadId);
  // Sales-owned stages: the acting sales user must own the lead (admins exempt).
  if (ownerOnly) assertLeadAccess(actor, lead);
  if (lead.status !== from) {
    throw httpError(409, 'This lead has already moved to a later stage. Refresh to see where it is now.');
  }
  const resolvedData = typeof data === 'function' ? data(lead) : data;
  const updated = await applyTransition(leadId, from, { status: to, ...resolvedData });
  await addLeadNote({ leadId, stage: noteStage, body: note, actor });
  await logStatusChange({
    entityType: 'Lead',
    entityId: leadId,
    oldValue: from,
    newValue: to,
    actor,
  });
  // Sales-owned destination queues are scoped to the lead's owner — notify that
  // one person, not every SALES_USER (who couldn't see or act on the lead).
  if (notifyRole === 'SALES_USER') {
    await notifyOneUser(salesOwner(lead), {
      type: 'STAGE_TRANSITION',
      title: `${lead.leadNumber} ${notifyTitle}`,
      message: lead.organizationName,
      leadId,
    });
  } else {
    await notifyRoles([notifyRole], {
      type: 'STAGE_TRANSITION',
      title: `${lead.leadNumber} ${notifyTitle}`,
      message: lead.organizationName,
      leadId,
    });
  }
  await refreshSidebarForRoles([...outgoing, ...ADMIN_ROLES]);
  return updated;
};

// Stage 8: delivery confirms installation → NOC L2.
export const completeInstallation = ({ leadId, actor, notes }) =>
  advance({
    leadId,
    actor,
    from: 'DISPATCHED',
    to: 'NOC_L2_PENDING',
    data: (lead) => ({
      installationCompletedAt: new Date(),
      pipelineNotes: appendNote(lead, 'INSTALLATION', notes, actor),
    }),
    notifyRole: 'NOC_L2_USER',
    notifyTitle: 'ready for NOC L2 config',
    outgoing: ['DELIVERY_USER'],
    note: notes,
    noteStage: 'INSTALLATION',
  });

// Stage 9: NOC L2 switch/network config → aggregator confirm (sales).
export const completeNocL2 = ({ leadId, actor, configNotes, config }) =>
  advance({
    leadId,
    actor,
    from: 'NOC_L2_PENDING',
    to: 'AGGREGATOR_CONFIRM_PENDING',
    data: {
      nocL2AssignedToId: actor.id,
      nocL2ConfigNotes: configNotes ?? null,
      nocL2Config: config ?? null,
    },
    notifyRole: 'SALES_USER',
    notifyTitle: 'awaiting aggregator confirmation',
    outgoing: ['NOC_L2_USER'],
    note: configNotes,
    noteStage: 'NOC_L2',
  });

// Stage 10: sales confirms one or more aggregators (each with a quantity) →
// software. Custom types (anything beyond the built-ins) are registered in the
// shared AggregatorType master on first use.
export const confirmAggregator = async ({ leadId, actor, selections, remark }) => {
  const { category } = await loadLead(leadId);
  const list = Array.isArray(selections) ? selections : [];
  if (!list.length) throw httpError(400, 'Select at least one aggregator type.');
  // BGP is an ISP-only aggregator option; everything else applies to every category.
  if (category !== 'ISP' && list.some((s) => s.type === 'BGP')) {
    throw httpError(400, 'BGP is available only for ISP leads.');
  }
  const types = list.map((s) => s.type);
  const updated = await advance({
    leadId,
    actor,
    from: 'AGGREGATOR_CONFIRM_PENDING',
    to: 'SOFTWARE_PENDING',
    // aggregatorTypes/aggregatorType mirror the selections for legacy readers.
    data: {
      aggregatorSelections: list,
      aggregatorTypes: types,
      aggregatorType: types[0],
      aggregatorConfirmRemark: remark,
    },
    notifyRole: 'SOFTWARE_USER',
    notifyTitle: 'ready for software setup',
    outgoing: ['SALES_USER'],
    note: remark,
    noteStage: 'AGGREGATOR',
    ownerOnly: true,
  });
  // Register custom names only AFTER the transition landed — a stale 409'd
  // confirm must not write to the shared master list. Soft-fail (CLAUDE.md §9):
  // a master-write error must never roll back the confirm itself.
  for (const s of list) {
    if (KNOWN_AGGREGATORS.includes(s.type)) continue;
    try {
      await prisma.aggregatorType.upsert({
        where: { name: s.type },
        update: {},
        create: { name: s.type, createdById: actor.id },
      });
    } catch (e) {
      console.warn('[aggregatorType.upsert] non-fatal:', e?.message);
    }
  }
  return updated;
};

// Stage 11: software portal/migration/IP-pool notice → NOC L3.
export const completeSoftware = async ({ leadId, actor, managedBy, portalUsername, portalUrl, portalPassword, notes }) => {
  // ISP leads carry their own routing (their AS number / BGP session) — no NOC
  // L3 IP allocation and no L3→L2 handoff. They jump straight to client handover.
  const { category } = await loadLead(leadId);
  const isIsp = category === 'ISP';

  // Who runs the operator's portal: only ISPs may self-manage (then no
  // credentials are captured — or stored, even if sent). Every other category
  // is software-managed by definition, so no choice is asked for.
  const effectiveManagedBy = isIsp ? managedBy : 'SOFTWARE';
  if (!['ISP', 'SOFTWARE'].includes(effectiveManagedBy)) {
    throw httpError(400, 'Pick who manages the portal — ISP or the software team.');
  }
  const softwareManaged = effectiveManagedBy === 'SOFTWARE';
  return advance({
    leadId,
    actor,
    from: 'SOFTWARE_PENDING',
    to: isIsp ? 'CLIENT_HANDOVER_PENDING' : 'NOC_L3_PENDING',
    data: (lead) => ({
      softwareAssignedToId: actor.id,
      portalManagedBy: effectiveManagedBy,
      portalUsername: softwareManaged ? portalUsername?.trim() || null : null,
      portalUrl: softwareManaged ? portalUrl?.trim() || null : null,
      portalPassword: softwareManaged ? portalPassword ?? null : null,
      ipPoolNoticeAt: new Date(),
      pipelineNotes: appendNote(lead, 'SOFTWARE', notes, actor),
    }),
    notifyRole: isIsp ? 'SALES_USER' : 'NOC_L3_USER',
    notifyTitle: isIsp ? 'ready for client handover' : 'ready for IP allocation',
    outgoing: ['SOFTWARE_USER'],
    note: notes,
    noteStage: 'SOFTWARE',
  });
};

// Stage 12: NOC L3 IP allocation + BNG config → L3→L2 handoff. Every
// aggregator selected at stage 10 must have a complete config section.
export const completeNocL3 = async ({ leadId, actor, ipAllocation }) => {
  const lead = await loadLead(leadId);
  // Stage check first so a stale tab gets the conventional 409, not a
  // confusing config-validation 400 for a lead that already moved on.
  if (lead.status !== 'NOC_L3_PENDING') {
    throw httpError(409, 'This lead is no longer awaiting NOC L3 — someone already completed it.');
  }
  // Selections → types-array (qty 1 each) → single legacy column → Mikrotik.
  const selections = Array.isArray(lead.aggregatorSelections) && lead.aggregatorSelections.length
    ? lead.aggregatorSelections
    : (lead.aggregatorTypes?.length ? lead.aggregatorTypes : [lead.aggregatorType || 'MIKROTIK'])
        .map((type) => ({ type, quantity: 1 }));
  const alloc = ipAllocation && typeof ipAllocation === 'object' ? ipAllocation : {};
  // When a BNG-class aggregator (BNG / BIRAS) is selected, MIKROTIK configs are
  // optional — it carries the aggregation. All-or-nothing: leave MIKROTIK fully
  // out, or provide every unit.
  const hasBng = selections.some((s) => BNG_CLASS.includes(s.type));
  const stored = {};
  for (const { type, quantity } of selections) {
    const required = requiredKeysFor(type);
    const units = Array.isArray(alloc[type]) ? alloc[type] : [];
    if (type === 'MIKROTIK' && hasBng && units.length === 0) continue; // bypassed
    if (units.length !== quantity) {
      throw httpError(400, `Provide ${quantity} ${type} configuration${quantity === 1 ? '' : 's'}.`);
    }
    units.forEach((u, i) => {
      const missing = !u || typeof u !== 'object' || required.some((k) => !String(u[k] ?? '').trim());
      if (missing) throw httpError(400, `Complete the ${type} #${i + 1} configuration before saving.`);
    });
    // Store only the selected types' units — extras were never validated.
    stored[type] = units;
  }
  return advance({
    leadId,
    actor,
    from: 'NOC_L3_PENDING',
    to: 'L3_TO_L2_HANDOFF',
    data: { nocL3AssignedToId: actor.id, ipAllocation: stored, bngConfigDoneAt: new Date() },
    // The next action is NOC L3 ASSIGNING this handoff to a specific L2 user
    // (assignL3ToL2 then notifies that individual). Notify NOC L3, not L2 —
    // no L2 user can see the handoff until it's assigned to them.
    notifyRole: 'NOC_L3_USER',
    notifyTitle: 'ready to assign L3→L2 handoff',
    outgoing: ['NOC_L3_USER'],
  });
};

// NOC send-back: a lead can arrive in a NOC queue un-workable through no fault
// of the NOC team — the install was never finished, the portal is wrong, the
// handoff carries a bad config. Each NOC stage returns the lead exactly one
// step back, to the team that owns the problem. The routing table IS the
// feature: a status that isn't a key here cannot be sent back at all, which is
// what keeps this from becoming a general-purpose "move to any stage" hole.
//
// No new forward edges are needed — the normal forward transition from each
// target already leads back into the NOC queue it came from.
const SEND_BACK_ROUTES = {
  NOC_L2_PENDING: { to: 'DISPATCHED', sender: 'NOC_L2_USER', notifyRole: 'DELIVERY_USER', noteStage: 'NOC_L2' },
  NOC_L3_PENDING: { to: 'SOFTWARE_PENDING', sender: 'NOC_L3_USER', notifyRole: 'SOFTWARE_USER', noteStage: 'NOC_L3' },
  L3_TO_L2_HANDOFF: { to: 'NOC_L3_PENDING', sender: 'NOC_L2_USER', notifyRole: 'NOC_L3_USER', noteStage: 'L3_TO_L2' },
};

export const sendBack = async ({ leadId, actor, reason }) => {
  const lead = await loadLead(leadId);
  const route = SEND_BACK_ROUTES[lead.status];
  // Stage check first so a stale tab gets the conventional 409 rather than a
  // confusing 403 for a lead that has already moved on.
  if (!route) {
    throw httpError(409, 'This lead is not currently in a NOC stage. Refresh to see where it is now.');
  }
  // Actor check: admin, or a staff user holding the sending stage's access.
  if (!hasAccess(actor, route.sender)) {
    throw httpError(403, 'Only the NOC team that owns this stage can send the lead back.');
  }
  const text = String(reason ?? '').trim();
  if (!text) {
    throw httpError(400, 'A reason is required to send a lead back.');
  }

  const updated = await applyTransition(leadId, lead.status, { status: route.to });

  await addLeadNote({ leadId, stage: route.noteStage, body: `Sent back: ${text}`, actor });
  await logStatusChange({
    entityType: 'Lead',
    entityId: leadId,
    oldValue: lead.status,
    newValue: route.to,
    actor,
    reason: `Sent back: ${text}`,
  });
  await notifyRoles([route.notifyRole], {
    type: 'STAGE_TRANSITION',
    title: `${lead.leadNumber} sent back — needs rework`,
    message: text,
    leadId,
  });
  await refreshSidebarForRoles([route.sender, route.notifyRole, ...ADMIN_ROLES]);
  return updated;
};

// Stage 13 routing: NOC L3 assigns (or reassigns) the handoff to a specific NOC
// L2 user. Not a status transition — the lead stays at L3_TO_L2_HANDOFF and can
// be reassigned any time.
export const assignL3ToL2 = async ({ leadId, actor, assignedToId, notes }) => {
  const lead = await loadLead(leadId);
  if (lead.status !== 'L3_TO_L2_HANDOFF') {
    throw httpError(409, 'This lead is not currently awaiting L3→L2 assignment.');
  }
  const assignee = await prisma.user.findUnique({
    where: { id: assignedToId },
    select: { id: true, name: true, role: true, accesses: true, isActive: true },
  });
  // Target check: the assignee must genuinely hold NOC L2 access. No admin
  // override — an admin isn't an assignable L2 technician (unchanged behaviour).
  if (!assignee || !assignee.isActive || !assignee.accesses.includes('NOC_L2_USER')) {
    throw httpError(400, 'Select an active NOC L2 user to assign.');
  }

  const updated = await prisma.lead.update({
    where: { id: leadId },
    data: { l3ToL2AssignedToId: assignedToId },
    ...withCreator,
  });

  const noteText = String(notes ?? '').trim();
  await addLeadNote({
    leadId,
    stage: 'L3_TO_L2',
    body: `Assigned L3→L2 handoff to ${assignee.name}.${noteText ? ` — ${noteText}` : ''}`,
    actor,
  });
  await notifyOneUser(assignedToId, {
    type: 'STAGE_TRANSITION',
    title: `${lead.leadNumber} assigned to you (L3→L2)`,
    message: lead.organizationName,
    leadId,
  });
  await refreshSidebarForRoles(['NOC_L2_USER', ...ADMIN_ROLES]);
  return updated;
};

// Stage 13: NOC L2 receives L3→L2 assignment → client handover (sales, M6).
export const completeL3ToL2 = ({ leadId, actor, notes }) =>
  advance({
    leadId,
    actor,
    from: 'L3_TO_L2_HANDOFF',
    to: 'CLIENT_HANDOVER_PENDING',
    data: (lead) => ({ pipelineNotes: appendNote(lead, 'L3_TO_L2', notes, actor) }),
    notifyRole: 'SALES_USER',
    notifyTitle: 'ready for client handover',
    outgoing: ['NOC_L2_USER'],
    note: notes,
    noteStage: 'L3_TO_L2',
  });

// Stage 14: sales completes client handover + agreement follow-up → software.
export const completeClientHandover = ({ leadId, actor, notes }) =>
  advance({
    leadId,
    actor,
    from: 'CLIENT_HANDOVER_PENDING',
    to: 'AGREEMENT_PENDING',
    data: (lead) => ({ pipelineNotes: appendNote(lead, 'CLIENT_HANDOVER', notes, actor) }),
    notifyRole: 'SOFTWARE_USER',
    notifyTitle: 'awaiting agreement verification',
    outgoing: ['SALES_USER'],
    note: notes,
    noteStage: 'CLIENT_HANDOVER',
    ownerOnly: true,
  });

// Stage 15: software marks the generated agreement as sent to the operator for
// signature. Pure tracking status — verify still works either way (guided, not
// blocked), but the queue shows where each agreement actually is.
export const markAgreementSentForSignature = async ({ leadId, actor }) => {
  const lead = await loadLead(leadId);
  if (lead.status !== 'AGREEMENT_PENDING') {
    throw httpError(409, 'This lead is not currently awaiting an agreement. Refresh to see where it is now.');
  }

  const updated = await applyTransition(leadId, 'AGREEMENT_PENDING', {
    status: 'AGREEMENT_SENT_FOR_SIGNATURE',
    agreementSentForSignatureAt: new Date(),
    agreementSentForSignatureById: actor.id,
  });

  await logStatusChange({
    entityType: 'Lead',
    entityId: leadId,
    oldValue: lead.status,
    newValue: 'AGREEMENT_SENT_FOR_SIGNATURE',
    actor,
  });
  await notifyOneUser(salesOwner(lead), {
    type: 'STAGE_TRANSITION',
    title: `${lead.leadNumber} agreement sent for signature`,
    message: `${lead.organizationName} — awaiting the operator's signed copy`,
    leadId,
  });
  await refreshSidebarForRoles(['SOFTWARE_USER', ...ADMIN_ROLES]);
  return updated;
};

// Stage 15: software verifies the signed agreement → COMPLETED (closes the lead).
// Valid from AGREEMENT_PENDING or AGREEMENT_SENT_FOR_SIGNATURE — marking "sent"
// is encouraged but never a hard gate.
export const verifyAgreement = async ({ leadId, actor }) => {
  const lead = await loadLead(leadId);
  if (lead.status !== 'AGREEMENT_PENDING' && lead.status !== 'AGREEMENT_SENT_FOR_SIGNATURE') {
    throw httpError(409, 'This lead is not currently awaiting agreement verification. Refresh to see where it is now.');
  }
  // Match the agreement type tolerantly — uploads canonicalise to AGREEMENT_DOC_TYPE,
  // but a case/whitespace slip must never silently block closure.
  const docs = await prisma.leadDocument.findMany({ where: { leadId }, select: { type: true } });
  const hasAgreement = docs.some(
    (d) => String(d.type ?? '').trim().toUpperCase() === AGREEMENT_DOC_TYPE,
  );
  if (!hasAgreement) {
    throw httpError(400, 'Upload the signed agreement before verifying.');
  }
  // Docs were optional earlier in the pipeline; the close-out is where the
  // category's full required list is enforced.
  const missing = missingRequiredDocs(lead.category, docs);
  if (missing.length) {
    throw httpError(400, `Upload the required document${missing.length === 1 ? '' : 's'} before completing: ${missing.join(', ')}.`);
  }

  const updated = await applyTransition(leadId, lead.status, {
    status: 'COMPLETED',
    agreementUploadedAt: lead.agreementUploadedAt || new Date(),
    agreementVerifiedById: actor.id,
  });

  await logStatusChange({
    entityType: 'Lead',
    entityId: leadId,
    oldValue: lead.status,
    newValue: 'COMPLETED',
    actor,
  });
  await notifyOneUser(salesOwner(lead), {
    type: 'STAGE_TRANSITION',
    title: `${lead.leadNumber} completed`,
    message: `${lead.organizationName} — agreement verified`,
    leadId,
  });
  await refreshSidebarForRoles(['SOFTWARE_USER', ...ADMIN_ROLES]);
  return updated;
};
