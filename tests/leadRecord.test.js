import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { getLeadRecord, updateLeadRecordSection } from '../src/services/leadRecord.service.js';
import { prisma, seedUsers, actor, createLead, cleanup, rejectsWithStatus, addDocument } from './helpers.mjs';

before(async () => {
  await seedUsers();
  await cleanup();
});
beforeEach(cleanup);
after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

const ADMIN = () => actor('ADMIN');
const edit = (leadId, section, data, reason = 'Correcting a typo') =>
  updateLeadRecordSection({ leadId, section, data, reason, actor: ADMIN() });

const leadEvents = (leadId) =>
  prisma.statusChangeLog.findMany({ where: { entityId: leadId, action: 'LEAD_ADMIN_EDITED' }, orderBy: { createdAt: 'asc' } });

test('the record bundles documents and notes', async () => {
  const lead = await createLead();
  await addDocument(lead.id, 'PAN');
  await prisma.leadNote.create({ data: { leadId: lead.id, stage: 'LEAD', body: 'created' } });
  const record = await getLeadRecord(lead.id);
  assert.equal(record.documents.length, 1);
  assert.equal(record.noteEntries.length, 1);
  assert.equal(record.createdBy.id, lead.createdById);
});

test('admin edits a stage the lead has not reached; status stays put and the change is logged with the reason', async () => {
  const lead = await createLead({ status: 'NEW', category: 'PIN_RATE', requirementDetails: {} });
  const record = await edit(lead.id, 'software', { portalUsername: 'acme', portalUrl: 'https://p.acme', portalPassword: 's3cret' }, 'Captured early from the call');
  assert.equal(record.status, 'NEW');
  assert.equal(record.portalUsername, 'acme');
  assert.equal(record.portalManagedBy, 'SOFTWARE', 'non-ISP portals are always software-managed');

  const [ev] = await leadEvents(lead.id);
  assert.equal(ev.reason, 'Captured early from the call');
  const changes = ev.changes;
  assert.ok(changes.some((c) => c.field === 'portalUsername' && c.to === 'acme'));
  const pw = changes.find((c) => c.field === 'portalPassword');
  assert.equal(pw.to, '••••••', 'the password is never logged in clear text');
  const note = await prisma.leadNote.findFirst({ where: { leadId: lead.id, stage: 'SOFTWARE' } });
  assert.match(note.body, /Captured early/);
});

test('a reason is required, and a save with no real change is refused', async () => {
  const lead = await createLead({ feasibilityNotes: 'ok' });
  await rejectsWithStatus(() => edit(lead.id, 'approval', { approvalNotes: 'x' }, ''), 400);
  await rejectsWithStatus(() => edit(lead.id, 'approval', { approvalNotes: 'x' }, '  a '), 400);
  await rejectsWithStatus(() => edit(lead.id, 'feasibility', { notes: 'ok' }), 400); // unchanged
  await rejectsWithStatus(() => edit(lead.id, 'nope', {}), 400);
});

test('only admins may edit the record', async () => {
  const lead = await createLead();
  await rejectsWithStatus(
    () => updateLeadRecordSection({ leadId: lead.id, section: 'approval', data: { approvalNotes: 'x' }, reason: 'because', actor: actor('SALES_USER') }),
    403,
  );
});

test('lead details are validated like the lead form and only changed fields are logged', async () => {
  const lead = await createLead({
    category: 'ISP', organizationName: 'Acme', email: 'ops@acme.test', phone: '9876543210',
    requirementDetails: { bandwidthMix: ['ILL'], bandwidthSpecs: { ILL: { value: 100, unit: 'MB' } } },
  });
  const base = {
    category: 'ISP', organizationName: 'Acme', email: 'ops@acme.test', phone: '9876543210', whatsappNumber: '9876543210',
    customerInterestLevel: 'WARM',
    requirementDetails: { bandwidthMix: ['ILL'], bandwidthSpecs: { ILL: { value: 100, unit: 'MB' } } },
  };
  await rejectsWithStatus(() => edit(lead.id, 'lead', { ...base, email: 'not-an-email' }), 400);
  const record = await edit(lead.id, 'lead', { ...base, city: 'Pune' });
  assert.equal(record.city, 'Pune');
  const [ev] = await leadEvents(lead.id);
  assert.ok(ev.changes.some((c) => c.field === 'city' && c.to === 'Pune'));
  assert.ok(!ev.changes.some((c) => c.field === 'organizationName'), 'unchanged fields are not logged');
});

test('lead details can reassign the owner (sales only) and clear the distributor for ISP', async () => {
  const { userId } = await import('./helpers.mjs');
  const lead = await createLead({ category: 'PIN_RATE', organizationName: 'Own', email: 'own@x.test', phone: '9876543210', requirementDetails: { estimatedUserCount: 10, ratePerUser: 5 } });
  const base = {
    category: 'PIN_RATE', organizationName: 'Own', email: 'own@x.test', phone: '9876543210', whatsappNumber: '9876543210',
    customerInterestLevel: 'WARM', requirementDetails: { estimatedUserCount: 10, ratePerUser: 5 },
  };
  await rejectsWithStatus(() => edit(lead.id, 'lead', { ...base, assignedSalesId: userId('STORE_USER') }), 400);
  const record = await edit(lead.id, 'lead', { ...base, assignedSalesId: userId('ADMIN') }); // the acting admin may own it
  assert.equal(record.assignedSalesId, userId('ADMIN'));
  assert.ok(record.distributorId, 'non-ISP leads fall back to the default distributor');
});

test('feasibility edits snapshot POPs and accept off-net details', async () => {
  const pop = await prisma.popLocation.create({ data: { name: 'POP Rec', latitude: 19, longitude: 72 } });
  const lead = await createLead();
  const record = await edit(lead.id, 'feasibility', {
    notes: 'Fiber available', networkType: 'OFF_NET', popIds: [pop.id],
    offNet: { nearestBts: 'BTS-9', btsLatitude: '19.1', btsLongitude: '72.9' },
    estimatedDeliveryAt: '2026-12-15',
  });
  assert.equal(record.feasibilityNetworkType, 'OFF_NET');
  assert.equal(record.popLocationId, pop.id);
  assert.deepEqual(record.feasibilityPops.map((p) => p.name), ['POP Rec']);
  assert.equal(record.feasibilityOffNet.btsLatitude, 19.1);
  await rejectsWithStatus(() => edit(lead.id, 'feasibility', { networkType: 'SATELLITE' }), 400);
});

test('changing the aggregator prunes NOC L3 configs that no longer apply', async () => {
  const lead = await createLead({
    category: 'PIN_RATE', requirementDetails: {},
    aggregatorSelections: [{ type: 'BNG', quantity: 2 }, { type: 'MIKROTIK', quantity: 1 }],
    aggregatorTypes: ['BNG', 'MIKROTIK'], aggregatorType: 'BNG',
    ipAllocation: { BNG: [{ vlan: '1' }, { vlan: '2' }], MIKROTIK: [{ vlan: '9' }] },
  });
  const record = await edit(lead.id, 'aggregator', { selections: [{ type: 'BNG', quantity: 1 }], remark: 'one BNG only' });
  assert.deepEqual(record.aggregatorTypes, ['BNG']);
  assert.deepEqual(record.ipAllocation, { BNG: [{ vlan: '1' }] });
  await rejectsWithStatus(() => edit(lead.id, 'aggregator', { selections: [{ type: 'BGP', quantity: 1 }] }), 400); // BGP is ISP-only
});

test('NOC L3 allocation is lenient for admins but capped at the selected quantity', async () => {
  const lead = await createLead({
    aggregatorSelections: [{ type: 'MIKROTIK', quantity: 1 }], aggregatorTypes: ['MIKROTIK'], aggregatorType: 'MIKROTIK',
  });
  const record = await edit(lead.id, 'nocL3', { ipAllocation: { MIKROTIK: [{ vlan: '42', bogusKey: 'x' }] } });
  assert.deepEqual(record.ipAllocation, { MIKROTIK: [{ vlan: '42' }] }, 'partial allowed, unknown keys dropped');
  await rejectsWithStatus(() => edit(lead.id, 'nocL3', { ipAllocation: { MIKROTIK: [{ vlan: '1' }, { vlan: '2' }] } }), 400);
});

test('pricing goes through the pricing validator and keeps legacy keys', async () => {
  const lead = await createLead({ category: 'PIN_RATE', requirementDetails: {}, pricing: { ratePerMonth: 100, popId: 'legacy' } });
  await rejectsWithStatus(() => edit(lead.id, 'pricing', { ratePerMonth: -5 }), 400);
  const record = await edit(lead.id, 'pricing', { ratePerMonth: 200, discountPercentage: 10 });
  assert.equal(record.pricing.ratePerMonth, 200);
  assert.equal(record.pricing.finalPrice, 180);
  assert.equal(record.pricing.popId, 'legacy');
});

test('monitoring software and NOC L2 config edit merge into nocL2Config', async () => {
  const lead = await createLead({ nocL2Config: { configType: 'SWITCH' } });
  let record = await edit(lead.id, 'l3ToL2', { software: { opm: true, cacti: true } });
  assert.deepEqual(record.nocL2Config, { configType: 'SWITCH', software: { opm: true, dude: false, cacti: true, logifyMail: false } });
  record = await edit(lead.id, 'nocL2', { configType: 'PORT', notes: 'port 7' });
  assert.equal(record.nocL2Config.configType, 'PORT');
  assert.equal(record.nocL2Config.software.opm, true, 'monitoring survives a config-type edit');
  assert.equal(record.nocL2ConfigNotes, 'port 7');
});
