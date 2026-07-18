import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canAccessLead, salesOwnerScope } from '../src/utils/leadAccess.js';

const staff = (accesses, id = 'u1') => ({ id, role: accesses[0], accesses });

// ── canAccessLead: a multi-access user's reach is the UNION of their accesses ──
test('a Sales+Feasibility user reaches a feasibility-pending lead they do not own', () => {
  const user = staff(['SALES_USER', 'FEASIBILITY_USER']);
  const lead = { assignedSalesId: 'someone-else', status: 'FEASIBILITY_PENDING' };
  assert.equal(canAccessLead(user, lead), true);
});

test('a Sales+Feasibility user still reaches their own sales lead', () => {
  const user = staff(['SALES_USER', 'FEASIBILITY_USER']);
  const lead = { assignedSalesId: 'u1', status: 'PRICING_PENDING' };
  assert.equal(canAccessLead(user, lead), true);
});

test('a Sales user cannot reach a sales lead owned by someone else', () => {
  const user = staff(['SALES_USER']);
  const lead = { assignedSalesId: 'someone-else', status: 'PRICING_PENDING' };
  assert.equal(canAccessLead(user, lead), false);
});

test('a Feasibility-only user cannot reach a NOC-stage lead', () => {
  const user = staff(['FEASIBILITY_USER']);
  const lead = { assignedSalesId: null, status: 'NOC_L2_PENDING' };
  assert.equal(canAccessLead(user, lead), false);
});

// ── salesOwnerScope keys on sales ACCESS, not the singular primary role ───────
test('salesOwnerScope scopes a staff user whose sales access is not their primary role', () => {
  const user = staff(['FEASIBILITY_USER', 'SALES_USER'], 'u9');
  assert.deepEqual(salesOwnerScope(user), { assignedSalesId: 'u9' });
});

test('salesOwnerScope returns {} for a user with no sales access', () => {
  assert.deepEqual(salesOwnerScope(staff(['FEASIBILITY_USER'])), {});
});
