import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripLeadForRole } from '../src/utils/leadVisibility.js';

const softwareLead = () => ({
  id: '1',
  organizationName: 'X',
  portalManagedBy: 'SOFTWARE',
  portalUrl: 'https://portal.test',
  portalUsername: 'ss_net',
  portalPassword: 'secret',
  ipPoolNoticeAt: new Date('2026-08-19T13:44:00Z'),
});

test('NOC L2 and L3 can see the software/portal details', () => {
  for (const role of ['NOC_L2_USER', 'NOC_L3_USER']) {
    const out = stripLeadForRole({ role }, softwareLead());
    assert.equal(out.portalManagedBy, 'SOFTWARE', `${role} portalManagedBy`);
    assert.equal(out.portalUrl, 'https://portal.test', `${role} portalUrl`);
    assert.equal(out.portalUsername, 'ss_net', `${role} portalUsername`);
    assert.ok(out.ipPoolNoticeAt, `${role} ipPoolNoticeAt`);
  }
});

test('a role outside the matrix still cannot see portal details', () => {
  const out = stripLeadForRole({ role: 'STORE_USER' }, softwareLead());
  assert.equal(out.portalUrl, undefined);
  assert.equal(out.portalManagedBy, undefined);
});

const fullLead = () => ({
  id: '2',
  organizationName: 'Y',
  contactPersonName: 'Ravi',
  phone: '9876543210',
  whatsappNumber: '9876543210',
  website: 'y.net',
  gender: 'MALE',
  email: 'ops@y.net',
  areaName: 'Tower A',
  city: 'Pune',
  pincode: '411001',
  latitude: 18.52,
  longitude: 73.85,
  sourceOfLead: 'REFERRAL',
  customerInterestLevel: 'HOT',
  notes: 'Wants go-live before Diwali',
  pricing: { ratePerMonth: 50000, finalPrice: 48000 },
  approvalNotes: 'Approved at 48k',
  pricingRevisionReason: 'Too high',
  pricingRevisionCount: 1,
  requirementDetails: {
    estimatedUserCount: 500,
    ratePerUser: 90,
    percentageSplit: 30,
    fixedRate: 1000,
    rateType: 'FIXED',
    bankDetails: { accountNumber: '123' },
  },
});

test('NOC L2 and L3 see every lead detail (contact, mobile, address, lat/long, source, notes)', () => {
  for (const role of ['NOC_L2_USER', 'NOC_L3_USER']) {
    const out = stripLeadForRole({ role, accesses: [role] }, fullLead());
    assert.equal(out.contactPersonName, 'Ravi', `${role} contact name`);
    assert.equal(out.phone, '9876543210', `${role} phone`);
    assert.equal(out.whatsappNumber, '9876543210', `${role} whatsapp`);
    assert.equal(out.website, 'y.net', `${role} website`);
    assert.equal(out.areaName, 'Tower A', `${role} address`);
    assert.equal(out.city, 'Pune', `${role} city`);
    assert.equal(out.latitude, 18.52, `${role} latitude`);
    assert.equal(out.longitude, 73.85, `${role} longitude`);
    assert.equal(out.sourceOfLead, 'REFERRAL', `${role} source`);
    assert.equal(out.customerInterestLevel, 'HOT', `${role} interest`);
    assert.equal(out.notes, 'Wants go-live before Diwali', `${role} notes`);
    assert.equal(out.requirementDetails.estimatedUserCount, 500, `${role} user count`);
  }
});

test('NOC L2 and L3 never see anything price-related', () => {
  for (const role of ['NOC_L2_USER', 'NOC_L3_USER']) {
    const out = stripLeadForRole({ role, accesses: [role] }, fullLead());
    for (const k of ['pricing', 'approvalNotes', 'pricingRevisionReason', 'pricingRevisionCount']) {
      assert.equal(k in out, false, `${role} must not see ${k}`);
    }
    for (const k of ['ratePerUser', 'percentageSplit', 'fixedRate', 'rateType', 'bankDetails']) {
      assert.equal(k in out.requirementDetails, false, `${role} must not see requirementDetails.${k}`);
    }
  }
});

test('visibility follows ALL granted accesses, not just the first (role label)', () => {
  // role mirrors accesses[0]; the NOC access must still unlock NOC fields.
  const user = { role: 'STORE_USER', accesses: ['STORE_USER', 'NOC_L3_USER'] };
  const out = stripLeadForRole(user, { ...fullLead(), ipAllocation: { BNG: [{ vlan: '100' }] } });
  assert.deepEqual(out.ipAllocation, { BNG: [{ vlan: '100' }] });
  assert.equal(out.phone, '9876543210');
  assert.equal(out.requirementDetails.estimatedUserCount, 500);
  assert.equal('pricing' in out, false);
});

test('multi-access requirement visibility is the union of each access', () => {
  // SOFTWARE sees rates, NOC sees sizing — together they see both, still no bank.
  const out = stripLeadForRole({ role: 'SOFTWARE_USER', accesses: ['SOFTWARE_USER', 'NOC_L2_USER'] }, fullLead());
  assert.equal(out.requirementDetails.estimatedUserCount, 500);
  assert.equal(out.requirementDetails.ratePerUser, 90);
  assert.equal('bankDetails' in out.requirementDetails, false);
});
