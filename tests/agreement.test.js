import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PizZip from 'pizzip';
import app from '../src/app.js';
import { formatAgreementDate } from '../src/services/agreement.service.js';
import { prisma, seedUsers, cleanup, createLead, TEST_PASSWORD } from './helpers.mjs';

let server;
let base;
const request = async (method, urlPath, { token, body } = {}) => {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(base + urlPath, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* binary / empty body */
  }
  return { status: res.status, body: json };
};

const tokens = {};

before(async () => {
  await seedUsers();
  await cleanup();
  server = app.listen(0);
  await new Promise((res) => server.once('listening', res));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await request('POST', '/api/auth/login', {
    body: { email: 'software_user@test.local', password: TEST_PASSWORD },
  });
  tokens.software = r.body?.token;
});

beforeEach(cleanup);

after(async () => {
  await cleanup();
  await new Promise((res) => server.close(res));
  await prisma.$disconnect();
});

// ── Date formatting (legal ordinal style) ────────────────────────────────────
test('formatAgreementDate renders the legal ordinal style', () => {
  assert.equal(formatAgreementDate(new Date(2026, 6, 14)), '14th day of July, 2026');
  assert.equal(formatAgreementDate(new Date(2026, 0, 1)), '1st day of January, 2026');
  assert.equal(formatAgreementDate(new Date(2026, 1, 2)), '2nd day of February, 2026');
  assert.equal(formatAgreementDate(new Date(2026, 2, 3)), '3rd day of March, 2026');
  // 11th–13th are always 'th', regardless of the last digit.
  assert.equal(formatAgreementDate(new Date(2026, 3, 11)), '11th day of April, 2026');
  assert.equal(formatAgreementDate(new Date(2026, 4, 12)), '12th day of May, 2026');
  assert.equal(formatAgreementDate(new Date(2026, 5, 13)), '13th day of June, 2026');
  assert.equal(formatAgreementDate(new Date(2026, 7, 21)), '21st day of August, 2026');
  assert.equal(formatAgreementDate(new Date(2026, 8, 22)), '22nd day of September, 2026');
  assert.equal(formatAgreementDate(new Date(2026, 9, 23)), '23rd day of October, 2026');
  assert.equal(formatAgreementDate(new Date(2026, 11, 31)), '31st day of December, 2026');
});

// ── Template carries the placeholder ─────────────────────────────────────────
test('agreement.docx template contains the {Agreement Date} placeholder', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const tpl = path.join(here, '..', 'src', 'templates', 'agreement.docx');
  const xml = new PizZip(fs.readFileSync(tpl)).file('word/document.xml').asText();
  assert.ok(xml.includes('{Agreement Date}'), 'placeholder present at the top of the template');
});

// ── Boundary validation ───────────────────────────────────────────────────────
test('POST /:id/agreement/generate rejects an invalid agreementDate → 400', async () => {
  const lead = await createLead({ status: 'AGREEMENT_PENDING' });
  const r = await request('POST', `/api/leads/${lead.id}/agreement/generate`, {
    token: tokens.software,
    body: { orgName: 'Acme Telecom', agreementDate: 'not-a-date' },
  });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /agreementDate/);
});
