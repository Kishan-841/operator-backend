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
