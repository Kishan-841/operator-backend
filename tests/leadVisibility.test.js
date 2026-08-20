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
