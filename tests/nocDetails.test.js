import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import * as sm from '../src/services/leadStateMachine.js';
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

const bng = (vlan = '100') => ({ mikrotikIp: '10.0.0.1', mikrotikIdentity: 'bng-1', loopbackIp: '1.1.1.1', vsi: 'VSI-1', subnetMask: '10.0.0.0/29', vlan });
const mikrotik = () => ({
  mikrotikIdentity: 'mk-1', mikrotikIp: '10.0.1.1', mikrotikGateway: '10.0.1.254',
  snatPool: ['100.64.0.0/22'], dynamicPool: ['10.10.0.0/16'], subnetMask: '10.0.1.0/29', vlan: '200',
});

// A lead that has been through every NOC stage and is now completed.
const nocLead = (over = {}) =>
  createLead({
    status: 'COMPLETED',
    nocL2Config: { configType: 'SWITCH', software: { opm: 'yes', dude: 'yes', cacti: 'yes' } },
    nocL2ConfigNotes: 'rack 4',
    aggregatorSelections: [{ type: 'BNG', quantity: 1 }],
    aggregatorTypes: ['BNG'],
    aggregatorType: 'BNG',
    ipAllocation: { BNG: [bng()] },
    ipDetails: { entries: [{ type: 'GAZON', ipv4: ['203.0.113.0/29'] }] },
    ...over,
  });

const L3 = () => actor('NOC_L3_USER');

test('NOC L2 config edit on a COMPLETED lead keeps software, leaves status, adds a note', async () => {
  const lead = await nocLead();
  const updated = await sm.updateNocDetails({
    leadId: lead.id,
    actor: L3(),
    nocL2: { configType: 'PORT', notes: 'moved to port 7' },
  });
  assert.equal(updated.status, 'COMPLETED');
  assert.equal(updated.nocL2Config.configType, 'PORT');
  assert.deepEqual(updated.nocL2Config.software, { opm: 'yes', dude: 'yes', cacti: 'yes' });
  assert.equal(updated.nocL2ConfigNotes, 'moved to port 7');
  const notes = await prisma.leadNote.findMany({ where: { leadId: lead.id } });
  assert.equal(notes.length, 1);
  assert.match(notes[0].body, /NOC details updated: NOC L2 config/);
});

test('IP allocation edit is validated against the current aggregator selection', async () => {
  const lead = await nocLead({ status: 'CLIENT_HANDOVER_PENDING' });
  const updated = await sm.updateNocDetails({ leadId: lead.id, actor: L3(), ipAllocation: { BNG: [bng('300')] } });
  assert.equal(updated.ipAllocation.BNG[0].vlan, '300');
  await rejectsWithStatus(
    () => sm.updateNocDetails({ leadId: lead.id, actor: L3(), ipAllocation: { BNG: [{ vlan: '1' }] } }),
    400,
  );
  await rejectsWithStatus(
    () => sm.updateNocDetails({ leadId: lead.id, actor: L3(), ipAllocation: { BNG: [bng(), bng()] } }),
    400,
  );
});

test('changing the aggregator requires a matching IP allocation when one is recorded', async () => {
  const lead = await nocLead();
  const selections = [{ type: 'BNG', quantity: 1 }, { type: 'MIKROTIK', quantity: 1 }];
  // BNG-class selected → MIKROTIK may be bypassed, so the old allocation still fits…
  const ok = await sm.updateNocDetails({ leadId: lead.id, actor: L3(), aggregator: { selections } });
  assert.deepEqual(ok.aggregatorTypes, ['BNG', 'MIKROTIK']);
  // …but switching to MIKROTIK-only makes the BNG-only allocation invalid.
  await rejectsWithStatus(
    () => sm.updateNocDetails({ leadId: lead.id, actor: L3(), aggregator: { selections: [{ type: 'MIKROTIK', quantity: 1 }] } }),
    400,
  );
  const both = await sm.updateNocDetails({
    leadId: lead.id,
    actor: L3(),
    aggregator: { selections: [{ type: 'MIKROTIK', quantity: 1 }] },
    ipAllocation: { MIKROTIK: [mikrotik()] },
  });
  assert.equal(both.aggregatorType, 'MIKROTIK');
  assert.deepEqual(both.aggregatorSelections, [{ type: 'MIKROTIK', quantity: 1 }]);
  assert.deepEqual(Object.keys(both.ipAllocation), ['MIKROTIK']);
});

test('aggregator change is fine before any IP allocation exists', async () => {
  const lead = await nocLead({ status: 'SOFTWARE_PENDING', ipAllocation: undefined, nocL2Config: undefined });
  const updated = await sm.updateNocDetails({
    leadId: lead.id,
    actor: L3(),
    aggregator: { selections: [{ type: 'BIRAS', quantity: 2 }] },
  });
  assert.deepEqual(updated.aggregatorSelections, [{ type: 'BIRAS', quantity: 2 }]);
  assert.equal(updated.status, 'SOFTWARE_PENDING');
});

test('BGP stays ISP-only on edit', async () => {
  const lead = await nocLead({ category: 'PIN_RATE', ipAllocation: undefined });
  await rejectsWithStatus(
    () => sm.updateNocDetails({ leadId: lead.id, actor: L3(), aggregator: { selections: [{ type: 'BGP', quantity: 1 }] } }),
    400,
  );
});

test('IP details edit (and clearing to null)', async () => {
  const lead = await nocLead();
  const updated = await sm.updateNocDetails({
    leadId: lead.id,
    actor: L3(),
    ipDetails: { entries: [{ type: 'ISP', irinnEmail: 'noc@isp.test', ipv4: ['198.51.100.0/30'] }] },
  });
  assert.equal(updated.ipDetails.entries[0].irinnEmail, 'noc@isp.test');
  const cleared = await sm.updateNocDetails({ leadId: lead.id, actor: L3(), ipDetails: null });
  assert.equal(cleared.ipDetails, null);
});

test('a section that was never recorded cannot be edited (409)', async () => {
  const lead = await nocLead({ status: 'NOC_L3_PENDING', ipAllocation: undefined });
  await rejectsWithStatus(
    () => sm.updateNocDetails({ leadId: lead.id, actor: L3(), ipAllocation: { BNG: [bng()] } }),
    409,
  );
  const early = await createLead({ status: 'NOC_L2_PENDING' });
  await rejectsWithStatus(
    () => sm.updateNocDetails({ leadId: early.id, actor: L3(), nocL2: { configType: 'PORT' } }),
    409,
  );
  await rejectsWithStatus(
    () => sm.updateNocDetails({ leadId: early.id, actor: L3(), aggregator: { selections: [{ type: 'BNG', quantity: 1 }] } }),
    409,
  );
});

test('only NOC L3 and admins may edit; an empty edit is a 400', async () => {
  const lead = await nocLead();
  await rejectsWithStatus(
    () => sm.updateNocDetails({ leadId: lead.id, actor: actor('NOC_L2_USER'), nocL2: { configType: 'PORT' } }),
    403,
  );
  const byAdmin = await sm.updateNocDetails({ leadId: lead.id, actor: actor('ADMIN'), nocL2: { configType: 'PORT' } });
  assert.equal(byAdmin.nocL2Config.configType, 'PORT');
  await rejectsWithStatus(() => sm.updateNocDetails({ leadId: lead.id, actor: L3() }), 400);
});
