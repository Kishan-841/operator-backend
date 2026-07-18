import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasAccess, hasRole, hasAnyRole, isAdmin } from '../src/utils/roleHelper.js';

const staff = (...accesses) => ({ role: accesses[0], accesses });
const admin = { role: 'ADMIN', accesses: [] };

// ── hasAccess: the access-set basis for staff authorization ──────────────────
test('hasAccess is true when the role is in the user access set', () => {
  assert.equal(hasAccess(staff('SALES_USER', 'FEASIBILITY_USER'), 'FEASIBILITY_USER'), true);
});

test('hasAccess is false for a role the staff user was not granted', () => {
  assert.equal(hasAccess(staff('SALES_USER'), 'NOC_L2_USER'), false);
});

test('hasAccess lets an admin through any role despite an empty access set', () => {
  assert.equal(hasAccess(admin, 'NOC_L3_USER'), true);
});

test('hasAccess tolerates a user with no accesses field', () => {
  assert.equal(hasAccess({ role: 'SALES_USER' }, 'SALES_USER'), false);
});

// ── hasRole / hasAnyRole now read the access set ─────────────────────────────
test('hasRole matches any granted access, not just a singular role', () => {
  const u = staff('SALES_USER', 'FEASIBILITY_USER');
  assert.equal(hasRole(u, 'SALES_USER'), true);
  assert.equal(hasRole(u, 'FEASIBILITY_USER'), true);
  assert.equal(hasRole(u, 'STORE_USER'), false);
});

test('hasAnyRole is true when the user holds at least one of the roles', () => {
  const u = staff('FEASIBILITY_USER');
  assert.equal(hasAnyRole(u, ['SALES_USER', 'FEASIBILITY_USER']), true);
  assert.equal(hasAnyRole(u, ['SALES_USER', 'STORE_USER']), false);
});

test('hasAnyRole lets an admin through', () => {
  assert.equal(hasAnyRole(admin, ['STORE_USER']), true);
});

test('isAdmin is unaffected by the access set', () => {
  assert.equal(isAdmin(admin), true);
  assert.equal(isAdmin(staff('SALES_USER')), false);
});
