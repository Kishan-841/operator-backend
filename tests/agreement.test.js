import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PizZip from 'pizzip';
import app from '../src/app.js';
import { formatAgreementDate } from '../src/services/agreement.service.js';
import { prisma, seedUsers, cleanup, createLead, addDocument, TEST_PASSWORD } from './helpers.mjs';

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
  const login = async (role) => {
    const rr = await request('POST', '/api/auth/login', {
      body: { email: `${role.toLowerCase()}@test.local`, password: TEST_PASSWORD },
    });
    return rr.body?.token;
  };
  tokens.software = await login('SOFTWARE_USER');
  tokens.sales = await login('SALES_USER');
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

// ── Authorization on generate ─────────────────────────────────────────────────
test('generate is blocked outside the agreement stage and for non-owners (no CAF burn)', async () => {
  // Software may only generate at an agreement stage — a NEW lead → 404 (access denied).
  const newLead = await createLead({ status: 'NEW' });
  const early = await request('POST', `/api/leads/${newLead.id}/agreement/generate`, {
    token: tokens.software,
    body: { orgName: 'Acme ISP' },
  });
  assert.equal(early.status, 404);

  // A sales user who doesn't own the lead can't generate (404, no CAF burned).
  const owned = await createLead({ status: 'AGREEMENT_PENDING' }); // owned by SALES_USER default
  const otherSales = await prisma.user.upsert({
    where: { email: 'sales-x@test.local' },
    update: { isActive: true },
    create: { name: 'Other Sales', email: 'sales-x@test.local', password: 'x', role: 'SALES_USER' },
  });
  const foreign = await createLead({ status: 'AGREEMENT_PENDING', assignedSalesId: otherSales.id });
  const denied = await request('POST', `/api/leads/${foreign.id}/agreement/generate`, {
    token: tokens.sales,
    body: { orgName: 'Acme ISP' },
  });
  assert.equal(denied.status, 404);
  assert.equal(
    (await prisma.lead.findUnique({ where: { id: foreign.id }, select: { cafNumber: true } })).cafNumber,
    null,
    'no CAF burned on a denied request',
  );

  // The owner at the agreement stage still works.
  const ok = await request('POST', `/api/leads/${owned.id}/agreement/generate`, {
    token: tokens.sales,
    body: { orgName: 'Acme ISP' },
  });
  assert.equal(ok.status, 200);
});

// ── ISP SLA ───────────────────────────────────────────────────────────────────
test('isp_sla.docx template contains the four SLA placeholders', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const tpl = path.join(here, '..', 'src', 'templates', 'isp_sla.docx');
  const xml = new PizZip(fs.readFileSync(tpl)).file('word/document.xml').asText();
  for (const ph of ['{Effective Date}', '{Customer Name}', '{CAF No}', '{Office Address}']) {
    assert.ok(xml.includes(ph), `${ph} present`);
  }
});

test('ISP generate assigns an auto-incremented CAF once and keeps it on regeneration', async () => {
  const leadA = await createLead({ status: 'AGREEMENT_PENDING' }); // ISP by default
  const leadB = await createLead({ status: 'AGREEMENT_PENDING', email: 'b@x.test', phone: '9876500009' });

  const genA = await request('POST', `/api/leads/${leadA.id}/agreement/generate`, {
    token: tokens.software,
    body: { orgName: 'Acme ISP', orgAddress: 'Pune', agreementDate: '2026-07-16' },
  });
  assert.equal(genA.status, 200);
  const cafA = (await prisma.lead.findUnique({ where: { id: leadA.id }, select: { cafNumber: true } })).cafNumber;
  assert.match(cafA, /^CAF-\d{2,}$/);

  // Second generation on the same lead keeps the same CAF.
  await request('POST', `/api/leads/${leadA.id}/agreement/generate`, {
    token: tokens.software,
    body: { orgName: 'Acme ISP' },
  });
  const cafA2 = (await prisma.lead.findUnique({ where: { id: leadA.id }, select: { cafNumber: true } })).cafNumber;
  assert.equal(cafA2, cafA, 'CAF fixed for the lead');

  // The next ISP lead gets the next number.
  await request('POST', `/api/leads/${leadB.id}/agreement/generate`, {
    token: tokens.software,
    body: { orgName: 'Beta ISP' },
  });
  const cafB = (await prisma.lead.findUnique({ where: { id: leadB.id }, select: { cafNumber: true } })).cafNumber;
  const n = (s) => Number(s.split('-')[1]);
  assert.equal(n(cafB), n(cafA) + 1, 'auto-increment');
});

test('non-ISP generate never assigns a CAF', async () => {
  const lead = await createLead({
    status: 'AGREEMENT_PENDING',
    category: 'PIN_RATE',
    requirementDetails: {},
  });
  const r = await request('POST', `/api/leads/${lead.id}/agreement/generate`, {
    token: tokens.software,
    body: { orgName: 'Franchise Co' },
  });
  assert.equal(r.status, 200);
  const caf = (await prisma.lead.findUnique({ where: { id: lead.id }, select: { cafNumber: true } })).cafNumber;
  assert.equal(caf, null);
});

// ── Boundary validation ───────────────────────────────────────────────────────
// ── Attaching already-uploaded lead documents ─────────────────────────────────
test('generate rejects attachDocumentIds belonging to another lead → 400', async () => {
  const lead = await createLead({ status: 'AGREEMENT_PENDING' });
  const otherLead = await createLead({ status: 'AGREEMENT_PENDING' });
  const foreignDoc = await addDocument(otherLead.id, 'PAN');
  const r = await request('POST', `/api/leads/${lead.id}/agreement/generate`, {
    token: tokens.software,
    body: { orgName: 'Acme Telecom', attachDocumentIds: [foreignDoc.id] },
  });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /no longer exist/);
});

test('generate names the document when its stored file is missing → 400', async () => {
  const lead = await createLead({ status: 'AGREEMENT_PENDING' });
  // helpers.addDocument records a storageKey that has no file on disk.
  const doc = await addDocument(lead.id, 'GST');
  const r = await request('POST', `/api/leads/${lead.id}/agreement/generate`, {
    token: tokens.software,
    body: { orgName: 'Acme Telecom', attachDocumentIds: [doc.id] },
  });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /GST\.pdf.*missing|missing/);
});

test('POST /:id/agreement/generate rejects an invalid agreementDate → 400', async () => {
  const lead = await createLead({ status: 'AGREEMENT_PENDING' });
  const r = await request('POST', `/api/leads/${lead.id}/agreement/generate`, {
    token: tokens.software,
    body: { orgName: 'Acme Telecom', agreementDate: 'not-a-date' },
  });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /agreementDate/);
});
