import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import prisma from '../src/config/db.js';

// Known password for all seeded test users (bcrypt-hashed in seedUsers).
export const TEST_PASSWORD = 'test1234';

// SAFETY: these tests truncate tables. Never let them run against a non-test DB.
if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error(
    `Refusing to run tests: DATABASE_URL is not a *_test database (${process.env.DATABASE_URL}). ` +
      `Run via "npm test" (loads .env.test).`,
  );
}

export const ROLES = [
  'SUPER_ADMIN',
  'ADMIN',
  'SALES_USER',
  'FEASIBILITY_USER',
  'DELIVERY_USER',
  'STORE_USER',
  'NOC_L2_USER',
  'NOC_L3_USER',
  'SOFTWARE_USER',
];

const users = {};

/**
 * One user per role (idempotent). Transitions reference these by id (FKs); the
 * bcrypt-hashed password lets the auth tests log in. `update` resets state so a
 * test that deactivates/edits a user can't leak into the next run.
 */
export async function seedUsers() {
  const password = await bcrypt.hash(TEST_PASSWORD, 10);
  for (const role of ROLES) {
    const email = `${role.toLowerCase()}@test.local`;
    users[role] = await prisma.user.upsert({
      where: { email },
      update: { password, role, name: role, isActive: true },
      create: { name: role, email, password, role },
    });
  }
  return users;
}

export const actor = (role) => ({ id: users[role].id, role: users[role].role, label: users[role].email });
export const userId = (role) => users[role].id;

let seq = 0;
/** Create a test lead (defaults to a NEW ISP lead). */
export function createLead(overrides = {}) {
  seq += 1;
  return prisma.lead.create({
    data: {
      leadNumber: `T-${Date.now()}-${seq}`,
      category: 'ISP',
      organizationName: 'Test Co',
      email: 'test@example.com',
      requirementDetails: { bandwidthMix: ['ILL'] },
      status: 'NEW',
      createdById: users.SALES_USER.id,
      // Ownership scoping (assertLeadAccess): the default SALES_USER actor
      // must own the lead or every sales transition 404s.
      assignedSalesId: users.SALES_USER.id,
      ...overrides,
    },
  });
}

export function addDocument(leadId, type = 'PAN', overrides = {}) {
  return prisma.leadDocument.create({
    data: { leadId, type, fileName: `${type}.pdf`, storageKey: `test/${type}.pdf`, ...overrides },
  });
}

/** Upload one document per required type for the category (agreement gate). */
export async function addRequiredDocs(leadId, category = 'ISP') {
  const { requiredDocsFor } = await import('../src/utils/docRequirements.js');
  for (const type of requiredDocsFor(category)) {
    await addDocument(leadId, type);
  }
}

/** A document that sales has already verified — passes the completeDocs gate. */
export function addApprovedDocument(leadId, type = 'PAN') {
  return addDocument(leadId, type, {
    salesApprovedAt: new Date(),
    salesApprovedById: users.SALES_USER.id,
  });
}

let logSeq = 0;
/** Seed a StatusChangeLog row (for dashboard/performance tests). */
export async function addLog({ changedById, action = 'STATUS_CHANGED', entityType = 'Lead', entityId = null, oldValue = null, newValue = null, createdAt = new Date(), salesOwnerId = undefined }) {
  logSeq += 1;
  // Mirror statusChangeLog.service: denormalise the lead's sales owner so
  // owner-scoped report queries (which filter on salesOwnerId) see the row.
  let owner = salesOwnerId;
  if (owner === undefined && entityType === 'Lead' && entityId) {
    const lead = await prisma.lead.findUnique({ where: { id: entityId }, select: { assignedSalesId: true } });
    owner = lead?.assignedSalesId ?? null;
  }
  return prisma.statusChangeLog.create({
    data: { changedById, action, entityType, entityId, oldValue, newValue, createdAt, salesOwnerId: owner ?? null },
  });
}

export const status = (id) =>
  prisma.lead.findUnique({ where: { id }, select: { status: true } }).then((l) => l?.status);

/** Remove all test rows (the whole DB is test data). FK-safe order. */
export async function cleanup() {
  // Delivery requests first (cascades their items + logs), then POs (cascades PO
  // items), then products — so no FK from DR-item → PO-item / product survives.
  await prisma.deliveryRequest.deleteMany({});
  await prisma.storePurchaseOrder.deleteMany({});
  await prisma.storeProduct.deleteMany({});
  await prisma.notification.deleteMany({});
  await prisma.aggregatorType.deleteMany({});
  await prisma.statusChangeLog.deleteMany({}); // all log rows (whole DB is test data)
  await prisma.lead.deleteMany({}); // cascades documents / materialReq / dispatch / deliveryRequest
  await prisma.vendor.deleteMany({});
}

let drSeq = 0;
/**
 * Create a lead sitting at AWAITING_DISPATCH with an APPROVED DeliveryRequest +
 * items, ready for assignMaterial. `items` = [{ productId, quantity }].
 * Returns the DeliveryRequest with its items.
 */
export async function createApprovedRequestLead(items) {
  drSeq += 1;
  const lead = await prisma.lead.create({
    data: {
      leadNumber: `T-DR-${Date.now()}-${drSeq}`,
      category: 'ISP',
      organizationName: 'Assign Co',
      email: 'assign@example.com',
      requirementDetails: { bandwidthMix: ['ILL'] },
      status: 'AWAITING_DISPATCH',
      createdById: users.SALES_USER.id,
      assignedSalesId: users.SALES_USER.id,
    },
  });
  return prisma.deliveryRequest.create({
    data: {
      requestNumber: `DR-T-${Date.now()}-${drSeq}`,
      leadId: lead.id,
      requestedById: users.DELIVERY_USER.id,
      status: 'APPROVED',
      items: { create: items.map((i) => ({ productId: i.productId, quantity: i.quantity })) },
    },
    include: { items: true, lead: true },
  });
}

let productSeq = 0;
/** Create a catalogue product (defaults to a serialized SWITCH). */
export function createProduct(overrides = {}) {
  productSeq += 1;
  const { createdById, ...rest } = overrides;
  return prisma.storeProduct.create({
    data: {
      category: 'SWITCH',
      modelNumber: `MODEL-${Date.now()}-${productSeq}`,
      brandName: 'Cisco',
      unit: 'pcs',
      createdById: createdById ?? users.STORE_USER.id,
      ...rest,
    },
  });
}

/**
 * Create a purchase order with one IN_STORE item = live stock for `productId`.
 * Serialized: pass `serialNumbers`. Bulk: pass `receivedQuantity` + unit product.
 */
export async function createStock({ productId, serialNumbers = null, receivedQuantity = null, status = 'IN_STORE' }) {
  productSeq += 1;
  return prisma.storePurchaseOrder.create({
    data: {
      poNumber: `PO-T-${Date.now()}-${productSeq}`,
      status: 'APPROVED',
      createdById: users.STORE_USER.id,
      items: {
        create: [
          {
            productId,
            quantity: serialNumbers ? serialNumbers.length : receivedQuantity ?? 0,
            serialNumbers: serialNumbers ?? [],
            receivedQuantity: receivedQuantity ?? (serialNumbers ? serialNumbers.length : 0),
            status,
            addedToStoreAt: status === 'IN_STORE' ? new Date() : null,
          },
        ],
      },
    },
    include: { items: true },
  });
}

/** Assert that an async fn rejects with a specific httpError `.status`. */
export async function rejectsWithStatus(fn, code) {
  await assert.rejects(fn, (err) => {
    assert.equal(err.status, code, `expected status ${code}, got ${err.status} (${err.message})`);
    return true;
  });
}

export { prisma };
