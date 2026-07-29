import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateLeadPayload } from '../src/validation/leadCategories.js';

const ispBase = (requirementDetails) => ({
  category: 'ISP',
  organizationName: 'Acme Telecom',
  email: 'ops@acme.test',
  whatsappNumber: '9876543210',
  phone: '9876543210',
  requirementDetails: {
    bandwidthMix: ['ILL'],
    bandwidthSpecs: { ILL: { value: 100, unit: 'MB' } },
    ...requirementDetails,
  },
});

test('ISP payload accepts a valid license category + number', () => {
  const r = validateLeadPayload(ispBase({ licenseNumber: 'ISP/2026/001', licenseCategory: 'VNO' }));
  assert.equal(r.ok, true);
  assert.equal(r.data.requirementDetails.licenseCategory, 'VNO');
  assert.equal(r.data.requirementDetails.licenseNumber, 'ISP/2026/001');
});

test('ISP payload is valid with no license fields (optional)', () => {
  const r = validateLeadPayload(ispBase());
  assert.equal(r.ok, true);
});

test('ISP payload rejects a license category outside A/B/C/VNO', () => {
  const r = validateLeadPayload(ispBase({ licenseCategory: 'D' }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path === 'requirementDetails.licenseCategory'));
});

// ── Contact person: phone or landline (at least one) ─────────────────────────
const contact = (over) => ({
  category: 'PIN_RATE',
  organizationName: 'Pin Co',
  email: 'pin@acme.test',
  whatsappNumber: '9876543210',
  phone: '9811111111',
  requirementDetails: { estimatedUserCount: 100, ratePerUser: 40 },
  ...over,
});

test('valid with phone only', () => {
  assert.equal(validateLeadPayload(contact({ phone: '9811111111', landlineNumber: '' })).ok, true);
});

test('valid with landline only (no phone)', () => {
  const r = validateLeadPayload(contact({ phone: '', landlineNumber: '022-12345678' }));
  assert.equal(r.ok, true);
  assert.equal(r.data.landlineNumber, '022-12345678');
});

test('valid with both phone and landline', () => {
  assert.equal(validateLeadPayload(contact({ phone: '9811111111', landlineNumber: '04012345678' })).ok, true);
});

test('rejects when neither phone nor landline is given', () => {
  const r = validateLeadPayload(contact({ phone: '', landlineNumber: '' }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path === 'phone'));
});

test('rejects a landline that is too short', () => {
  assert.equal(validateLeadPayload(contact({ phone: '', landlineNumber: '123' })).ok, false);
});

test('rejects a landline that is too long', () => {
  assert.equal(validateLeadPayload(contact({ phone: '', landlineNumber: '0123456789012345' })).ok, false);
});

test('a bad phone (not 10 digits) is still rejected even with a landline present', () => {
  assert.equal(validateLeadPayload(contact({ phone: '12345', landlineNumber: '04012345678' })).ok, false);
});
