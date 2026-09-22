import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import * as sm from '../src/services/leadStateMachine.js';
import { validateFiberRoutes } from '../src/validation/feasibilityVendors.js';
import { prisma, seedUsers, actor, createLead, cleanup, rejectsWithStatus } from './helpers.mjs';

before(async () => {
  await seedUsers();
  await cleanup();
});
beforeEach(cleanup);
after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

const own = (m) => ({ kind: 'OWN', fiberMeters: m });

// ── validator ────────────────────────────────────────────────────────────────
test('validateFiberRoutes: Primary required, backups optional', () => {
  assert.equal(validateFiberRoutes({ PRIMARY: [own(100)] }).ok, true);
  assert.equal(validateFiberRoutes({ PRIMARY: [] }).ok, false);
  assert.equal(validateFiberRoutes({}).ok, false);
  assert.equal(validateFiberRoutes(null).ok, false);
  const r = validateFiberRoutes({ PRIMARY: [own(1)], SECONDARY: [], TERTIARY: [own(2)] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.SECONDARY, []);
  assert.deepEqual(r.data.FOURTH, [], 'missing backups normalise to []');
});

test('validateFiberRoutes: a bad segment in a backup route is rejected with its path', () => {
  const r = validateFiberRoutes({ PRIMARY: [own(1)], FOURTH: [{ kind: 'VENDOR', fiberMeters: 5 }] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path.startsWith('FOURTH.0')));
});

// ── completeFeasibility with routes ─────────────────────────────────────────
test('completeFeasibility stores Primary in feasibilityVendors and backups separately', async () => {
  const lead = await createLead({ status: 'FEASIBILITY_PENDING' });
  const vendor = await prisma.vendor.create({ data: { type: 'FIBER', name: 'Backup Fiber Co' } });
  const updated = await sm.completeFeasibility({
    leadId: lead.id,
    actor: actor('FEASIBILITY_USER'),
    feasible: true,
    notes: '',
    routes: {
      PRIMARY: [own(500)],
      SECONDARY: [{ kind: 'VENDOR', vendorId: vendor.id, fiberMeters: 800 }],
      TERTIARY: [],
      FOURTH: [],
    },
  });
  assert.equal(updated.status, 'PRICING_PENDING');
  assert.equal(updated.feasibilityVendors[0].fiberMeters, 500);
  assert.equal(updated.feasibilityBackupRoutes.SECONDARY[0].vendorName, 'Backup Fiber Co');
  assert.deepEqual(updated.feasibilityBackupRoutes.TERTIARY, []);
});

test('completeFeasibility with legacy vendors[] still works (Primary only)', async () => {
  const lead = await createLead({ status: 'FEASIBILITY_PENDING' });
  const updated = await sm.completeFeasibility({
    leadId: lead.id,
    actor: actor('FEASIBILITY_USER'),
    feasible: true,
    notes: '',
    vendors: [own(300)],
  });
  assert.equal(updated.feasibilityVendors[0].fiberMeters, 300);
});

// ── updateFiberRoutes: editable at any stage ────────────────────────────────
const reviewed = (over = {}) =>
  createLead({
    status: 'COMPLETED',
    feasibilityReviewedAt: new Date(),
    feasibilityVendors: [own(100)],
    ...over,
  });

test('updateFiberRoutes edits routes on a COMPLETED lead without changing status', async () => {
  const lead = await reviewed();
  const updated = await sm.updateFiberRoutes({
    leadId: lead.id,
    actor: actor('FEASIBILITY_USER'),
    routes: { PRIMARY: [own(150)], SECONDARY: [own(900)], TERTIARY: [], FOURTH: [] },
  });
  assert.equal(updated.status, 'COMPLETED');
  assert.equal(updated.feasibilityVendors[0].fiberMeters, 150);
  assert.equal(updated.feasibilityBackupRoutes.SECONDARY[0].fiberMeters, 900);
  const notes = await prisma.leadNote.findMany({ where: { leadId: lead.id, stage: 'FEASIBILITY' } });
  assert.equal(notes.length, 1);
  assert.match(notes[0].body, /Fiber routes updated/);
});

test('updateFiberRoutes: admins may edit too', async () => {
  const lead = await reviewed({ status: 'NOC_L2_PENDING' });
  const updated = await sm.updateFiberRoutes({
    leadId: lead.id,
    actor: actor('ADMIN'),
    routes: { PRIMARY: [own(10)] },
  });
  assert.equal(updated.feasibilityVendors[0].fiberMeters, 10);
});

test('updateFiberRoutes: other roles get 403', async () => {
  const lead = await reviewed();
  await rejectsWithStatus(
    () => sm.updateFiberRoutes({ leadId: lead.id, actor: actor('NOC_L2_USER'), routes: { PRIMARY: [own(1)] } }),
    403,
  );
});

test('updateFiberRoutes: a lead that has not passed feasibility gets 409', async () => {
  const pending = await createLead({ status: 'FEASIBILITY_PENDING' });
  await rejectsWithStatus(
    () => sm.updateFiberRoutes({ leadId: pending.id, actor: actor('FEASIBILITY_USER'), routes: { PRIMARY: [own(1)] } }),
    409,
  );
  const fresh = await createLead({ status: 'NEW' });
  await rejectsWithStatus(
    () => sm.updateFiberRoutes({ leadId: fresh.id, actor: actor('FEASIBILITY_USER'), routes: { PRIMARY: [own(1)] } }),
    409,
  );
});

test('updateFiberRoutes: Primary cannot be emptied', async () => {
  const lead = await reviewed();
  await rejectsWithStatus(
    () => sm.updateFiberRoutes({ leadId: lead.id, actor: actor('FEASIBILITY_USER'), routes: { PRIMARY: [] } }),
    400,
  );
});

test('updateFiberRoutes: an unknown vendor gets 400', async () => {
  const lead = await reviewed();
  await rejectsWithStatus(
    () =>
      sm.updateFiberRoutes({
        leadId: lead.id,
        actor: actor('FEASIBILITY_USER'),
        routes: {
          PRIMARY: [own(1)],
          SECONDARY: [{ kind: 'VENDOR', vendorId: '00000000-0000-4000-8000-000000000000', fiberMeters: 5 }],
        },
      }),
    400,
  );
});
