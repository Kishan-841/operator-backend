import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import app from '../src/app.js';
import { prisma, seedUsers, cleanup, createLead, addDocument, TEST_PASSWORD } from './helpers.mjs';

// ── HTTP harness ──────────────────────────────────────────────────────────────
let server;
let base;
const request = async (method, path, { token, body } = {}) => {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(base + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* empty/non-JSON */
  }
  return { status: res.status, body: json };
};
const login = async (role) => {
  const r = await request('POST', '/api/auth/login', {
    body: { email: `${role.toLowerCase()}@test.local`, password: TEST_PASSWORD },
  });
  return r.body?.token;
};
const tokens = {};

before(async () => {
  await seedUsers();
  await cleanup();
  server = app.listen(0);
  await new Promise((res) => server.once('listening', res));
  base = `http://127.0.0.1:${server.address().port}`;
  tokens.software = await login('SOFTWARE_USER');
  tokens.sales = await login('SALES_USER');
  tokens.admin = await login('ADMIN');
});
beforeEach(cleanup);
after(async () => {
  await cleanup();
  await new Promise((res) => server.close(res));
  await prisma.$disconnect();
});

const verifyUrl = (leadId, docId) => `/api/leads/${leadId}/documents/${docId}/verification`;

// ── Document verification ─────────────────────────────────────────────────────
test('software user verifies a document on a DOCS_UPLOADED lead → 200', async () => {
  const lead = await createLead({ status: 'DOCS_UPLOADED' });
  const doc = await addDocument(lead.id, 'PAN');
  const r = await request('PATCH', verifyUrl(lead.id, doc.id), {
    token: tokens.software,
    body: { status: 'VERIFIED' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.verificationStatus, 'VERIFIED');
  assert.ok(r.body.data.verifiedBy, 'records who verified it');
});

test('software user rejects a document → 200 REJECTED and the lead goes back to docs stage', async () => {
  const lead = await createLead({ status: 'DOCS_UPLOADED' });
  const doc = await addDocument(lead.id, 'AGREEMENT');
  const r = await request('PATCH', verifyUrl(lead.id, doc.id), {
    token: tokens.software,
    body: { status: 'REJECTED', note: 'scan is blurred' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.verificationStatus, 'REJECTED');
  assert.equal(r.body.data.verificationNote, 'scan is blurred');
  // The lead itself was sent back to the sales docs stage with the reason.
  const after = await prisma.lead.findUnique({ where: { id: lead.id } });
  assert.equal(after.status, 'APPROVED');
  assert.equal(after.docsRevisionReason, 'scan is blurred');
  assert.equal(after.docsRevisionCount, 1);
});

test('rejecting without a reason → 400', async () => {
  const lead = await createLead({ status: 'DOCS_UPLOADED' });
  const doc = await addDocument(lead.id);
  const r = await request('PATCH', verifyUrl(lead.id, doc.id), {
    token: tokens.software,
    body: { status: 'REJECTED' },
  });
  assert.equal(r.status, 400);
});

test('an invalid verification status → 400', async () => {
  const lead = await createLead({ status: 'DOCS_UPLOADED' });
  const doc = await addDocument(lead.id);
  const r = await request('PATCH', verifyUrl(lead.id, doc.id), {
    token: tokens.software,
    body: { status: 'BOGUS' },
  });
  assert.equal(r.status, 400);
});

test('resetting verification to PENDING clears the verifier', async () => {
  const lead = await createLead({ status: 'DOCS_UPLOADED' });
  const doc = await addDocument(lead.id);
  await request('PATCH', verifyUrl(lead.id, doc.id), { token: tokens.software, body: { status: 'VERIFIED' } });
  const r = await request('PATCH', verifyUrl(lead.id, doc.id), {
    token: tokens.software,
    body: { status: 'PENDING' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.verificationStatus, 'PENDING');
  assert.equal(r.body.data.verifiedBy, null);
});

test('verifying a doc on a lead not at the docs-verify stage → 409', async () => {
  const lead = await createLead({ status: 'APPROVED' });
  const doc = await addDocument(lead.id);
  const r = await request('PATCH', verifyUrl(lead.id, doc.id), {
    token: tokens.software,
    body: { status: 'VERIFIED' },
  });
  assert.equal(r.status, 409);
});

test('verifying a non-existent document → 404', async () => {
  const lead = await createLead({ status: 'DOCS_UPLOADED' });
  const r = await request('PATCH', verifyUrl(lead.id, randomUUID()), {
    token: tokens.software,
    body: { status: 'VERIFIED' },
  });
  assert.equal(r.status, 404);
});

test('document verification is forbidden for a non-software role → 403', async () => {
  const lead = await createLead({ status: 'DOCS_UPLOADED' });
  const doc = await addDocument(lead.id);
  const r = await request('PATCH', verifyUrl(lead.id, doc.id), {
    token: tokens.sales,
    body: { status: 'VERIFIED' },
  });
  assert.equal(r.status, 403);
});

test('document verification without a token → 401', async () => {
  const lead = await createLead({ status: 'DOCS_UPLOADED' });
  const doc = await addDocument(lead.id);
  const r = await request('PATCH', verifyUrl(lead.id, doc.id), { body: { status: 'VERIFIED' } });
  assert.equal(r.status, 401);
});

test('verifying a document writes a DOC_VERIFIED event', async () => {
  const lead = await createLead({ status: 'DOCS_UPLOADED' });
  const doc = await addDocument(lead.id);
  await request('PATCH', verifyUrl(lead.id, doc.id), { token: tokens.software, body: { status: 'VERIFIED' } });
  const count = await prisma.statusChangeLog.count({
    where: { action: 'DOC_VERIFIED', entityType: 'Lead', entityId: lead.id },
  });
  assert.equal(count, 1);
});

// ── Event log ─────────────────────────────────────────────────────────────────
test('GET /api/events (admin) returns a paginated envelope', async () => {
  const r = await request('GET', '/api/events', { token: tokens.admin });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.items));
  assert.ok(r.body.pagination && typeof r.body.pagination.total === 'number');
});

test('GET /api/events is forbidden for a non-admin → 403', async () => {
  const r = await request('GET', '/api/events', { token: tokens.sales });
  assert.equal(r.status, 403);
});

test('GET /api/events without a token → 401', async () => {
  const r = await request('GET', '/api/events');
  assert.equal(r.status, 401);
});

test('creating a lead surfaces a LEAD_CREATED event with the lead number resolved', async () => {
  const created = await request('POST', '/api/leads', {
    token: tokens.sales,
    body: {
      category: 'ISP',
      organizationName: 'Event Co',
      email: 'event@acme.test',
      phone: '9876543210',
      whatsappNumber: '9876543210',
      requirementDetails: { bandwidthMix: ['ILL'], bandwidthSpecs: { ILL: { value: 100, unit: 'MB' } } },
    },
  });
  assert.equal(created.status, 201);
  const leadNumber = created.body.data.leadNumber;

  const r = await request('GET', '/api/events?action=LEAD_CREATED', { token: tokens.admin });
  assert.equal(r.status, 200);
  const match = r.body.items.find((e) => e.leadNumber === leadNumber);
  assert.ok(match, 'LEAD_CREATED event is present with the resolved lead number');
  assert.equal(match.action, 'LEAD_CREATED');
});

test('the event log filters by entityType', async () => {
  const r = await request('GET', '/api/events?entityType=Auth', { token: tokens.admin });
  assert.equal(r.status, 200);
  assert.ok(r.body.items.every((e) => e.entityType === 'Auth'));
});

test('the event log free-text search finds an event by lead number', async () => {
  const created = await request('POST', '/api/leads', {
    token: tokens.sales,
    body: {
      category: 'ISP',
      organizationName: 'Searchable Co',
      email: 'search@acme.test',
      phone: '9876543210',
      whatsappNumber: '9876543210',
      requirementDetails: { bandwidthMix: ['P2P'], bandwidthSpecs: { P2P: { value: 1, unit: 'GB' } } },
    },
  });
  const leadNumber = created.body.data.leadNumber;
  const r = await request('GET', `/api/events?q=${encodeURIComponent(leadNumber)}`, { token: tokens.admin });
  assert.equal(r.status, 200);
  assert.ok(r.body.items.some((e) => e.leadNumber === leadNumber));
});
