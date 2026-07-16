import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import app from '../src/app.js';
import { prisma, seedUsers, cleanup, createLead, addDocument, addApprovedDocument, TEST_PASSWORD, userId } from './helpers.mjs';

// ── HTTP harness: run the real app on an ephemeral port, talk to it over fetch ──
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
    /* non-JSON / empty body */
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
  await prisma.pincode.deleteMany({});
  await prisma.pincode.createMany({
    data: [
      { pincode: '400001', officeName: 'Bazargate SO', district: 'MUMBAI', state: 'MAHARASHTRA' },
      { pincode: '110001', officeName: 'Connaught Place', district: 'NEW DELHI', state: 'DELHI' },
    ],
  });

  server = app.listen(0);
  await new Promise((res) => server.once('listening', res));
  base = `http://127.0.0.1:${server.address().port}`;

  tokens.admin = await login('ADMIN');
  tokens.sales = await login('SALES_USER');
  tokens.feasibility = await login('FEASIBILITY_USER');
  tokens.nocL2 = await login('NOC_L2_USER');
  tokens.software = await login('SOFTWARE_USER');
});

beforeEach(cleanup);

after(async () => {
  await cleanup();
  await prisma.pincode.deleteMany({});
  await new Promise((res) => server.close(res));
  await prisma.$disconnect();
});

// ── Health ───────────────────────────────────────────────────────────────────
test('GET /api/health → 200 ok', async () => {
  const r = await request('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'ok');
});

// ── Auth ───────────────────────────────────────────────────────────────────
test('login with valid credentials → 200 + token + role', async () => {
  const r = await request('POST', '/api/auth/login', {
    body: { email: 'sales_user@test.local', password: TEST_PASSWORD },
  });
  assert.equal(r.status, 200);
  assert.ok(r.body.token, 'returns a token');
  assert.equal(r.body.user.role, 'SALES_USER');
});

test('login with wrong password → 401', async () => {
  const r = await request('POST', '/api/auth/login', {
    body: { email: 'sales_user@test.local', password: 'wrong' },
  });
  assert.equal(r.status, 401);
});

test('login with unknown email → 401', async () => {
  const r = await request('POST', '/api/auth/login', {
    body: { email: 'nobody@test.local', password: TEST_PASSWORD },
  });
  assert.equal(r.status, 401);
});

test('login with a non-string email → 400 (not a 500 crash)', async () => {
  const r = await request('POST', '/api/auth/login', { body: { email: 12345, password: 'x' } });
  assert.equal(r.status, 400);
});

test('reject with a non-string reason → 400 (not a 500 crash)', async () => {
  const lead = await createLead({ status: 'PENDING_APPROVAL' });
  const r = await request('POST', `/api/leads/${lead.id}/reject`, {
    token: tokens.admin,
    body: { reason: { note: 'bad' } },
  });
  assert.equal(r.status, 400);
});

test('login missing credentials → 400', async () => {
  const r = await request('POST', '/api/auth/login', { body: { email: 'x@test.local' } });
  assert.equal(r.status, 400);
});

test('login as a deactivated user → 401', async () => {
  const password = await bcrypt.hash(TEST_PASSWORD, 10);
  await prisma.user.upsert({
    where: { email: 'deactivated@test.local' },
    update: { isActive: false, password },
    create: { name: 'Deactivated', email: 'deactivated@test.local', password, role: 'SALES_USER', isActive: false },
  });
  const r = await request('POST', '/api/auth/login', {
    body: { email: 'deactivated@test.local', password: TEST_PASSWORD },
  });
  assert.equal(r.status, 401);
});

test('GET /api/auth/me with a token → 200 + current user', async () => {
  const r = await request('GET', '/api/auth/me', { token: tokens.sales });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.email, 'sales_user@test.local');
});

test('GET /api/auth/me without a token → 401', async () => {
  const r = await request('GET', '/api/auth/me');
  assert.equal(r.status, 401);
});

test('GET /api/auth/me with a garbage token → 401', async () => {
  const r = await request('GET', '/api/auth/me', { token: 'not.a.jwt' });
  assert.equal(r.status, 401);
});

// ── Role gating (requireRole) ────────────────────────────────────────────────
test('GET /api/users allowed for admin, forbidden for sales', async () => {
  const ok = await request('GET', '/api/users', { token: tokens.admin });
  assert.equal(ok.status, 200);

  const forbidden = await request('GET', '/api/users', { token: tokens.sales });
  assert.equal(forbidden.status, 403);
});

test('queue endpoints are gated to their owning role', async () => {
  const ok = await request('GET', '/api/leads/nocl2/queue', { token: tokens.nocL2 });
  assert.equal(ok.status, 200);

  const forbidden = await request('GET', '/api/leads/nocl2/queue', { token: tokens.sales });
  assert.equal(forbidden.status, 403);
});

test('protected endpoint without a token → 401', async () => {
  const r = await request('GET', '/api/leads/nocl2/queue');
  assert.equal(r.status, 401);
});

// ── Lead controller ──────────────────────────────────────────────────────────
const validLead = () => ({
  category: 'ISP',
  organizationName: 'Acme Telecom',
  email: 'ops@acme.test',
  phone: '9876543210',
  whatsappNumber: '9876543210',
  requirementDetails: { bandwidthMix: ['ILL'], bandwidthSpecs: { ILL: { value: 100, unit: 'MB' } } },
});

test('POST /api/leads (sales, valid) → 201 with a generated lead number', async () => {
  const r = await request('POST', '/api/leads', { token: tokens.sales, body: validLead() });
  assert.equal(r.status, 201);
  assert.match(r.body.data.leadNumber, /^OPC-\d{4}$/);
  assert.equal(r.body.data.status, 'NEW');
});

test('POST /api/leads forbidden for a non-sales role → 403', async () => {
  const r = await request('POST', '/api/leads', { token: tokens.feasibility, body: validLead() });
  assert.equal(r.status, 403);
});

test('POST /api/leads with an invalid body → 400 with errors', async () => {
  const r = await request('POST', '/api/leads', {
    token: tokens.sales,
    body: { category: 'ISP', organizationName: '', email: 'not-an-email' },
  });
  assert.equal(r.status, 400);
  assert.ok(Array.isArray(r.body.errors) && r.body.errors.length > 0);
});

test('POST /api/leads rejects a phone that is not exactly 10 digits → 400', async () => {
  const r = await request('POST', '/api/leads', {
    token: tokens.sales,
    body: { ...validLead(), phone: '+91 98765 43210' },
  });
  assert.equal(r.status, 400);
  assert.ok(Array.isArray(r.body.errors) && r.body.errors.length > 0);
});

test('POST /api/leads rejects a missing mobile number → 400', async () => {
  const { phone, ...noPhone } = validLead();
  const r = await request('POST', '/api/leads', { token: tokens.sales, body: noPhone });
  assert.equal(r.status, 400);
});

test('POST /api/leads blocks duplicates by email or mobile; rejected leads may be re-created', async () => {
  const first = await request('POST', '/api/leads', { token: tokens.sales, body: validLead() });
  assert.equal(first.status, 201);

  // Same email, different mobile → 400 pointing at email.
  const dupEmail = await request('POST', '/api/leads', {
    token: tokens.sales,
    body: { ...validLead(), phone: '9876500000', whatsappNumber: '9876500000' },
  });
  assert.equal(dupEmail.status, 400);
  assert.ok(dupEmail.body.errors.some((e) => e.path === 'email'), 'names the email field');

  // Same mobile, different email → 400 pointing at phone.
  const dupPhone = await request('POST', '/api/leads', {
    token: tokens.sales,
    body: { ...validLead(), email: 'other@acme.test' },
  });
  assert.equal(dupPhone.status, 400);
  assert.ok(dupPhone.body.errors.some((e) => e.path === 'phone'), 'names the phone field');

  // Case-insensitive email match still blocks.
  const dupCase = await request('POST', '/api/leads', {
    token: tokens.sales,
    body: { ...validLead(), email: 'OPS@ACME.TEST', phone: '9876500002', whatsappNumber: '9876500002' },
  });
  assert.equal(dupCase.status, 400);

  // A REJECTED lead doesn't block re-creation.
  await prisma.lead.updateMany({ where: { email: 'ops@acme.test' }, data: { status: 'REJECTED' } });
  const again = await request('POST', '/api/leads', { token: tokens.sales, body: validLead() });
  assert.equal(again.status, 201);
});

test('two concurrent creates of the same contact → exactly one wins (no TOCTOU dup)', async () => {
  const [a, b] = await Promise.all([
    request('POST', '/api/leads', { token: tokens.sales, body: validLead() }),
    request('POST', '/api/leads', { token: tokens.sales, body: validLead() }),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [201, 400], 'one created, one blocked');
  assert.equal(await prisma.lead.count({ where: { email: 'ops@acme.test', status: { not: 'REJECTED' } } }), 1);
});

test("PUT /api/leads/:id blocks updating into another lead's email/mobile (self excluded)", async () => {
  const a = await request('POST', '/api/leads', { token: tokens.sales, body: validLead() });
  assert.equal(a.status, 201);
  const bBody = { ...validLead(), email: 'b@acme.test', phone: '9876500001', whatsappNumber: '9876500001' };
  const b = await request('POST', '/api/leads', { token: tokens.sales, body: bBody });
  assert.equal(b.status, 201);

  // b takes a's email → 400
  const clash = await request('PUT', `/api/leads/${b.body.data.id}`, {
    token: tokens.sales,
    body: { ...bBody, email: 'ops@acme.test' },
  });
  assert.equal(clash.status, 400);

  // b keeping its own contact details is not a self-duplicate.
  const ok = await request('PUT', `/api/leads/${b.body.data.id}`, { token: tokens.sales, body: bBody });
  assert.equal(ok.status, 200);
});

// ── Rejected documents can't satisfy the docs-verify gate ─────────────────────
test('rejecting a document clears its approval and blocks completeDocs until re-approved', async () => {
  const lead = await createLead({ status: 'DOCS_UPLOADED' });
  const doc = await addApprovedDocument(lead.id); // salesApprovedAt set

  // Reject it — should also clear salesApprovedAt and bounce the lead to APPROVED.
  const rej = await request('PATCH', `/api/leads/${lead.id}/documents/${doc.id}/verification`, {
    token: tokens.software,
    body: { status: 'REJECTED', note: 'wrong file' },
  });
  assert.equal(rej.status, 200);
  const after = await prisma.leadDocument.findUnique({
    where: { id: doc.id },
    select: { salesApprovedAt: true, verificationStatus: true },
  });
  assert.equal(after.salesApprovedAt, null, 'approval cleared on reject');
  assert.equal(after.verificationStatus, 'REJECTED');

  // Put the lead back to DOCS_UPLOADED with the doc still REJECTED; the gate must block.
  await prisma.lead.update({ where: { id: lead.id }, data: { status: 'DOCS_UPLOADED' } });
  const blocked = await request('POST', `/api/leads/${lead.id}/complete-docs`, { token: tokens.software });
  assert.equal(blocked.status, 400, 'completeDocs blocked while a rejected doc is present');
});

// ── Vendor list authorization ─────────────────────────────────────────────────
test('GET /api/vendors is restricted to admin/sales; other roles get 403 (no bank-detail leak)', async () => {
  await prisma.vendor.create({
    data: {
      type: 'COMMISSION', name: 'Acme Fiber', commissionPercentage: 12.5,
      gst: 'GST123', pan: 'PAN123', bankDetails: { accountNumber: '9999', ifsc: 'HDFC0001' },
    },
  });
  // Software (a non-manage role) must NOT be able to read the full vendor list.
  const forbidden = await request('GET', '/api/vendors', { token: tokens.software });
  assert.equal(forbidden.status, 403);
  const l2 = await request('GET', '/api/vendors', { token: tokens.nocL2 });
  assert.equal(l2.status, 403);
  // Sales + admin still can (management surface).
  const sales = await request('GET', '/api/vendors', { token: tokens.sales });
  assert.equal(sales.status, 200);
  assert.ok(sales.body.items.some((v) => v.bankDetails?.accountNumber === '9999'));
});

// ── Admin documents browser ──────────────────────────────────────────────────
test('GET /api/documents groups documents under their lead (one row per lead)', async () => {
  const lead = await createLead();
  await addDocument(lead.id, 'PAN');
  await addDocument(lead.id, 'GST');
  const r = await request('GET', '/api/documents', { token: tokens.admin });
  assert.equal(r.status, 200);
  assert.equal(r.body.items.length, 1, 'pagination counts leads, not documents');
  const row = r.body.items[0];
  assert.equal(row.id, lead.id);
  assert.equal(row.documents.length, 2);
  // Type filter narrows both the docs shown and the leads listed.
  const filtered = await request('GET', '/api/documents?type=PAN', { token: tokens.admin });
  assert.equal(filtered.body.items[0].documents.length, 1);
  const none = await request('GET', '/api/documents?type=AGREEMENT', { token: tokens.admin });
  assert.equal(none.body.items.length, 0);
});

// ── Duplicate-lead approval flow ─────────────────────────────────────────────
test('duplicate approval: request → admin approves → one duplicate creation allowed', async () => {
  const first = await request('POST', '/api/leads', { token: tokens.sales, body: validLead() });
  assert.equal(first.status, 201);

  // The duplicate 400 tells the form there is no request yet.
  const blocked = await request('POST', '/api/leads', { token: tokens.sales, body: validLead() });
  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.duplicate?.approvalStatus, 'NONE');

  // No duplicate exists for a random identity → request refused.
  const pointless = await request('POST', '/api/leads/duplicate-approvals', {
    token: tokens.sales,
    body: { email: 'nobody@nowhere.test', phone: '9111111111' },
  });
  assert.equal(pointless.status, 400);

  // Real request → 201; a second identical request while pending → 409.
  const reqBody = { email: 'ops@acme.test', phone: '9876543210', organizationName: 'Acme Telecom', reason: 'second outlet' };
  const created = await request('POST', '/api/leads/duplicate-approvals', { token: tokens.sales, body: reqBody });
  assert.equal(created.status, 201);
  const dupReq = await request('POST', '/api/leads/duplicate-approvals', { token: tokens.sales, body: reqBody });
  assert.equal(dupReq.status, 409);

  // The duplicate 400 now reports PENDING; creation still blocked.
  const stillBlocked = await request('POST', '/api/leads', { token: tokens.sales, body: validLead() });
  assert.equal(stillBlocked.status, 400);
  assert.equal(stillBlocked.body.duplicate?.approvalStatus, 'PENDING');

  // Admin lists and approves (sales cannot).
  const forbidden = await request('GET', '/api/leads/duplicate-approvals?status=PENDING', { token: tokens.sales });
  assert.equal(forbidden.status, 403);
  const list = await request('GET', '/api/leads/duplicate-approvals?status=PENDING', { token: tokens.admin });
  assert.equal(list.status, 200);
  assert.equal(list.body.items.length, 1);
  const approvalId = list.body.items[0].id;
  const approve = await request('POST', `/api/leads/duplicate-approvals/${approvalId}/approve`, { token: tokens.admin });
  assert.equal(approve.status, 200);

  // The requester can now create the duplicate — once.
  const allowed = await request('POST', '/api/leads', { token: tokens.sales, body: validLead() });
  assert.equal(allowed.status, 201);
  const spent = await request('POST', '/api/leads', { token: tokens.sales, body: validLead() });
  assert.equal(spent.status, 400, 'approval is consumed by one creation');
});

test('duplicate approval: rejection keeps creation blocked and reports REJECTED', async () => {
  await request('POST', '/api/leads', { token: tokens.sales, body: validLead() });
  const created = await request('POST', '/api/leads/duplicate-approvals', {
    token: tokens.sales,
    body: { email: 'ops@acme.test', phone: '9876543210' },
  });
  assert.equal(created.status, 201);
  const rejectNoReason = await request('POST', `/api/leads/duplicate-approvals/${created.body.data.id}/reject`, {
    token: tokens.admin,
    body: {},
  });
  assert.equal(rejectNoReason.status, 400);
  const reject = await request('POST', `/api/leads/duplicate-approvals/${created.body.data.id}/reject`, {
    token: tokens.admin,
    body: { reason: 'same location, no need' },
  });
  assert.equal(reject.status, 200);

  const blocked = await request('POST', '/api/leads', { token: tokens.sales, body: validLead() });
  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.duplicate?.approvalStatus, 'REJECTED');
});

test('lead deletion: sales may delete their own NEW leads; admin any; others blocked', async () => {
  // Sales deletes their own NEW lead.
  const own = await request('POST', '/api/leads', { token: tokens.sales, body: validLead() });
  const del = await request('DELETE', `/api/leads/${own.body.data.id}`, { token: tokens.sales });
  assert.equal(del.status, 200);
  assert.equal(await prisma.lead.count({ where: { id: own.body.data.id } }), 0, 'row gone');

  // Sales cannot delete once the lead entered the pipeline.
  const moving = await createLead({ status: 'FEASIBILITY_PENDING' });
  const blocked = await request('DELETE', `/api/leads/${moving.id}`, { token: tokens.sales });
  assert.equal(blocked.status, 400);

  // Sales cannot delete another owner's lead (404, never revealing existence).
  const foreign = await createLead({ assignedSalesId: userId('ADMIN'), createdById: userId('ADMIN') });
  const notMine = await request('DELETE', `/api/leads/${foreign.id}`, { token: tokens.sales });
  assert.equal(notMine.status, 404);

  // Admin deletes any lead at any stage (documents cascade).
  await addDocument(moving.id);
  const adminDel = await request('DELETE', `/api/leads/${moving.id}`, { token: tokens.admin });
  assert.equal(adminDel.status, 200);
  assert.equal(await prisma.lead.count({ where: { id: moving.id } }), 0);
});

test('admin can pick the lead owner; sales cannot assign others; invalid target → 400', async () => {
  // Admin assigns the lead to the sales user.
  const assigned = await request('POST', '/api/leads', {
    token: tokens.admin,
    body: { ...validLead(), assignedSalesId: userId('SALES_USER') },
  });
  assert.equal(assigned.status, 201);
  assert.equal(assigned.body.data.assignedSalesId, userId('SALES_USER'));
  // ...and the sales user sees it in their owner-scoped list.
  const mine = await request('GET', '/api/leads', { token: tokens.sales });
  assert.ok(mine.body.items.some((l) => l.id === assigned.body.data.id), 'owner sees the lead');

  // Admin without the field owns it themselves.
  const own = await request('POST', '/api/leads', {
    token: tokens.admin,
    body: { ...validLead(), email: 'own@acme.test', phone: '9876500003', whatsappNumber: '9876500003' },
  });
  assert.equal(own.status, 201);
  assert.equal(own.body.data.assignedSalesId, userId('ADMIN'));

  // A non-sales target → 400.
  const badTarget = await request('POST', '/api/leads', {
    token: tokens.admin,
    body: { ...validLead(), email: 'bad@acme.test', phone: '9876500004', whatsappNumber: '9876500004', assignedSalesId: userId('STORE_USER') },
  });
  assert.equal(badTarget.status, 400);

  // Sales users can't assign someone else — the field is ignored.
  const salesTry = await request('POST', '/api/leads', {
    token: tokens.sales,
    body: { ...validLead(), email: 's@acme.test', phone: '9876500005', whatsappNumber: '9876500005', assignedSalesId: userId('ADMIN') },
  });
  assert.equal(salesTry.status, 201);
  assert.equal(salesTry.body.data.assignedSalesId, userId('SALES_USER'));
});

test('admin duplicate create: warned first, allowed with allowDuplicate; sales cannot use the flag', async () => {
  await request('POST', '/api/leads', { token: tokens.sales, body: validLead() });

  // Admin without the flag → 400 flagged as admin-overridable.
  const warned = await request('POST', '/api/leads', { token: tokens.admin, body: validLead() });
  assert.equal(warned.status, 400);
  assert.equal(warned.body.duplicate?.approvalStatus, 'ADMIN_OVERRIDE');

  // Admin with the flag → created.
  const forced = await request('POST', '/api/leads', {
    token: tokens.admin,
    body: { ...validLead(), allowDuplicate: true },
  });
  assert.equal(forced.status, 201);

  // Sales sending the flag → still blocked (the flag is admin-only).
  const salesForced = await request('POST', '/api/leads', {
    token: tokens.sales,
    body: { ...validLead(), allowDuplicate: true },
  });
  assert.equal(salesForced.status, 400);
});

test("duplicate approval: another user's approval doesn't unlock creation", async () => {
  await request('POST', '/api/leads', { token: tokens.sales, body: validLead() });
  // Admin requests + approves for themselves; the sales user still can't use it.
  const created = await request('POST', '/api/leads/duplicate-approvals', {
    token: tokens.admin,
    body: { email: 'ops@acme.test', phone: '9876543210' },
  });
  assert.equal(created.status, 201);
  await request('POST', `/api/leads/duplicate-approvals/${created.body.data.id}/approve`, { token: tokens.admin });
  const blocked = await request('POST', '/api/leads', { token: tokens.sales, body: validLead() });
  assert.equal(blocked.status, 400, 'approval is bound to its requester');
});

test('GET /api/leads (sales) returns a paginated envelope', async () => {
  await request('POST', '/api/leads', { token: tokens.sales, body: validLead() });
  const r = await request('GET', '/api/leads', { token: tokens.sales });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.items));
  assert.ok(r.body.pagination && typeof r.body.pagination.total === 'number');
});

// ── IP / IRINN details (docs stage → shown to NOC) ───────────────────────────
test('PATCH /api/leads/:id/ip-details saves multiple typed IP entries', async () => {
  const created = await request('POST', '/api/leads', { token: tokens.sales, body: validLead() });
  const id = created.body.data.id;
  const r = await request('PATCH', `/api/leads/${id}/ip-details`, {
    token: tokens.sales,
    body: {
      entries: [
        // Multiple IPs per entry; a bare string is accepted and wrapped.
        { type: 'ISP', irinnEmail: 'noc@irinn.test', ipv4: ['203.0.113.0/24', '203.0.114.0/24'], ipv6: '2001:db8::/48' },
        { type: 'GAZON', ipv4: ['198.51.100.0/24', ' ', ''] }, // blanks dropped
      ],
    },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.ipDetails.entries.length, 2);
  assert.equal(r.body.data.ipDetails.entries[0].irinnEmail, 'noc@irinn.test');

  const fetched = await request('GET', `/api/leads/${id}`, { token: tokens.sales });
  assert.deepEqual(fetched.body.data.ipDetails.entries[0].ipv4, ['203.0.113.0/24', '203.0.114.0/24']);
  assert.deepEqual(fetched.body.data.ipDetails.entries[0].ipv6, ['2001:db8::/48']);
  assert.equal(fetched.body.data.ipDetails.entries[1].type, 'GAZON');
  assert.deepEqual(fetched.body.data.ipDetails.entries[1].ipv4, ['198.51.100.0/24']);
});

test('ip-details: a Gazon entry never stores an IRINN email, and blank entries are dropped', async () => {
  const created = await request('POST', '/api/leads', { token: tokens.sales, body: validLead() });
  const r = await request('PATCH', `/api/leads/${created.body.data.id}/ip-details`, {
    token: tokens.sales,
    body: {
      entries: [
        { type: 'GAZON', irinnEmail: 'noc@irinn.test', ipv4: '198.51.100.0/24' }, // email must be stripped
        { type: 'ISP', irinnEmail: '', ipv4: '', ipv6: '' }, // all blank → dropped
      ],
    },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.ipDetails.entries.length, 1);
  assert.equal(r.body.data.ipDetails.entries[0].irinnEmail, undefined);
});

test('PATCH /api/leads/:id/ip-details rejects an invalid IRINN email → 400', async () => {
  const created = await request('POST', '/api/leads', { token: tokens.sales, body: validLead() });
  const r = await request('PATCH', `/api/leads/${created.body.data.id}/ip-details`, {
    token: tokens.sales,
    body: { entries: [{ type: 'ISP', irinnEmail: 'not-an-email' }] },
  });
  assert.equal(r.status, 400);
});

test('PATCH /api/leads/:id/ip-details rejects an unknown entry type → 400', async () => {
  const created = await request('POST', '/api/leads', { token: tokens.sales, body: validLead() });
  const r = await request('PATCH', `/api/leads/${created.body.data.id}/ip-details`, {
    token: tokens.sales,
    body: { entries: [{ type: 'OTHER', ipv4: '10.0.0.1' }] },
  });
  assert.equal(r.status, 400);
});

test('ip-details: legacy flat body still saves as a single ISP entry', async () => {
  const created = await request('POST', '/api/leads', { token: tokens.sales, body: validLead() });
  const r = await request('PATCH', `/api/leads/${created.body.data.id}/ip-details`, {
    token: tokens.sales,
    body: { irinnEmail: 'noc@irinn.test', ipv4: '203.0.113.0/24' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.ipDetails.entries.length, 1);
  assert.equal(r.body.data.ipDetails.entries[0].type, 'ISP');
  assert.deepEqual(r.body.data.ipDetails.entries[0].ipv4, ['203.0.113.0/24']);
});

test('PATCH /api/leads/:id/ip-details is scoped — another sales owner gets 404', async () => {
  const created = await request('POST', '/api/leads', { token: tokens.sales, body: validLead() });
  // feasibility user has no sales ownership; a different sales user would 404 too.
  const r = await request('PATCH', `/api/leads/${created.body.data.id}/ip-details`, {
    token: tokens.feasibility,
    body: { entries: [{ type: 'GAZON', ipv4: '10.0.0.0/24' }] },
  });
  assert.equal(r.status, 403); // requireRole('SALES_USER') blocks feasibility before ownership
});

// ── Pincode controller ───────────────────────────────────────────────────────
test('GET /api/pincodes?q= searches by pincode prefix', async () => {
  const r = await request('GET', '/api/pincodes?q=4000', { token: tokens.sales });
  assert.equal(r.status, 200);
  assert.ok(r.body.items.some((p) => p.pincode === '400001'));
});

test('GET /api/pincodes with no query → empty list (never dumps the table)', async () => {
  const r = await request('GET', '/api/pincodes', { token: tokens.sales });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.items, []);
});

test('GET /api/pincodes without a token → 401', async () => {
  const r = await request('GET', '/api/pincodes?q=4000');
  assert.equal(r.status, 401);
});

// ── Sidebar counts ────────────────────────────────────────────────────────────
test('GET /api/leads/sidebar-counts reflects leads per pipeline status', async () => {
  await createLead({ status: 'FEASIBILITY_PENDING' });
  await createLead({ status: 'FEASIBILITY_PENDING' });
  await createLead({ status: 'PENDING_APPROVAL' });

  const r = await request('GET', '/api/leads/sidebar-counts', { token: tokens.sales });
  assert.equal(r.status, 200);
  assert.equal(r.body.counts.feasibilityPending, 2);
  assert.equal(r.body.counts.pendingApproval, 1);
  assert.equal(r.body.counts.dispatchPending, 0);
});

test('l3ToL2Pending badge for an L2 user counts only handoffs assigned to them', async () => {
  await createLead({ status: 'L3_TO_L2_HANDOFF' }); // unassigned (or another L2's)
  await createLead({ status: 'L3_TO_L2_HANDOFF', l3ToL2AssignedToId: userId('NOC_L2_USER') });

  // The L2 queue lists only their assigned handoffs — the badge must match it.
  const l2 = await request('GET', '/api/leads/sidebar-counts', { token: tokens.nocL2 });
  assert.equal(l2.status, 200);
  assert.equal(l2.body.counts.l3ToL2Pending, 1, 'L2 badge matches the assigned-only queue');

  const admin = await request('GET', '/api/leads/sidebar-counts', { token: tokens.admin });
  assert.equal(admin.body.counts.l3ToL2Pending, 2, 'admins still see the stage total');
});

test('poApprovalPending counts POs awaiting admin approval (admins only)', async () => {
  await prisma.storePurchaseOrder.create({
    data: { poNumber: `PO-T-${Date.now()}-1`, createdById: userId('STORE_USER'), status: 'PENDING_ADMIN' },
  });
  await prisma.storePurchaseOrder.create({
    data: { poNumber: `PO-T-${Date.now()}-2`, createdById: userId('STORE_USER'), status: 'APPROVED' },
  });

  const admin = await request('GET', '/api/leads/sidebar-counts', { token: tokens.admin });
  assert.equal(admin.status, 200);
  assert.equal(admin.body.counts.poApprovalPending, 1);

  // The PO Approvals tab is admin-only — others skip the extra count query.
  const sales = await request('GET', '/api/leads/sidebar-counts', { token: tokens.sales });
  assert.equal(sales.body.counts.poApprovalPending, undefined);
});

// The stage-11 docs-verification work-view was removed (2026-07-03) — docs are
// verified once, at stage 5b below. The per-doc verification endpoint remains.

// ── Docs-verify work-view (stage 5b — SOFTWARE verifies what sales uploaded) ──
test('docs-verify queue lists leads sent for verification, not upload-stage leads', async () => {
  const sentForVerify = await createLead({ status: 'DOCS_UPLOADED' });
  await addDocument(sentForVerify.id);
  const stillUploading = await createLead({ status: 'APPROVED' }); // upload stage
  await addDocument(stillUploading.id);

  const r = await request('GET', '/api/leads/docs-verify/queue', { token: tokens.software });
  assert.equal(r.status, 200);
  const ids = r.body.items.map((l) => l.id);
  assert.ok(ids.includes(sentForVerify.id), 'lead sent for verification is listed');
  assert.ok(!ids.includes(stillUploading.id), 'lead still at the upload stage is not listed');
});

test('docs-verify queue shows software EVERY owner\'s leads', async () => {
  const otherSales = await prisma.user.upsert({
    where: { email: 'sales-other@test.local' },
    update: { isActive: true },
    create: { name: 'Other Sales', email: 'sales-other@test.local', password: 'x', role: 'SALES_USER' },
  });
  const lead = await createLead({ status: 'DOCS_UPLOADED', assignedSalesId: otherSales.id });
  await addDocument(lead.id);

  const r = await request('GET', '/api/leads/docs-verify/queue', { token: tokens.software });
  assert.equal(r.status, 200);
  assert.ok(r.body.items.some((l) => l.id === lead.id), 'software verifies regardless of sales owner');
});

test('docs-verify queue is forbidden for sales — verification is software\'s job', async () => {
  const r = await request('GET', '/api/leads/docs-verify/queue', { token: tokens.sales });
  assert.equal(r.status, 403);
});

test('docsVerifyPending counts leads sent for verification', async () => {
  await createLead({ status: 'DOCS_UPLOADED' });
  await createLead({ status: 'APPROVED' }); // upload stage → counts toward docsPending, not verify

  const r = await request('GET', '/api/leads/sidebar-counts', { token: tokens.software });
  assert.equal(r.status, 200);
  assert.equal(r.body.counts.docsVerifyPending, 1);
});

test('software approves an uploaded doc at the verify stage; sales cannot', async () => {
  const lead = await createLead({ status: 'DOCS_UPLOADED' });
  const doc = await addDocument(lead.id);

  const denied = await request('PATCH', `/api/leads/${lead.id}/documents/${doc.id}/sales-approve`, {
    token: tokens.sales,
    body: { approved: true },
  });
  assert.equal(denied.status, 403);

  const ok = await request('PATCH', `/api/leads/${lead.id}/documents/${doc.id}/sales-approve`, {
    token: tokens.software,
    body: { approved: true },
  });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.data.salesApprovedAt, 'approval stamped');
});

test('doc approval is rejected while the lead is still at the upload stage', async () => {
  const lead = await createLead({ status: 'APPROVED' }); // not yet sent for verification
  const doc = await addDocument(lead.id);
  // Software can't even see upload-stage leads (object-level 404); admins,
  // who can see everything, get the explicit wrong-stage conflict.
  const asSoftware = await request('PATCH', `/api/leads/${lead.id}/documents/${doc.id}/sales-approve`, {
    token: tokens.software,
    body: { approved: true },
  });
  assert.equal(asSoftware.status, 404);
  const asAdmin = await request('PATCH', `/api/leads/${lead.id}/documents/${doc.id}/sales-approve`, {
    token: tokens.admin,
    body: { approved: true },
  });
  assert.equal(asAdmin.status, 409);
});

// ── Role-scoped lead visibility — each role sees only its relevant fields ─────
const fullLead = (overrides = {}) =>
  createLead({
    contactPersonName: 'Meera K',
    phone: '9822011111',
    email: 'ops@viz.test',
    latitude: 18.52,
    longitude: 73.85,
    category: 'JV',
    requirementDetails: {
      userCount: 900,
      percentageSplit: 60,
      bankDetails: { accountName: 'X', accountNumber: '1', ifsc: 'HDFC0000001', bankName: 'HDFC' },
      scopeOfWork: 'rollout',
    },
    pricing: { ratePerMonth: 90000 },
    ipDetails: { entries: [{ type: 'ISP', ipv4: ['203.0.113.0/24'] }] },
    nocL2Config: { configType: 'PORT' },
    ipAllocation: { subnet: '10.1.1.0/24' },
    portalUsername: 'viz-co',
    portalPassword: 'super-secret',
    aggregatorType: 'BNG',
    ...overrides,
  });

test('feasibility queue rows hide pricing, bank details, portal creds, NOC configs', async () => {
  await fullLead({ status: 'FEASIBILITY_PENDING' });
  const r = await request('GET', '/api/leads/feasibility/queue', { token: tokens.feasibility });
  assert.equal(r.status, 200);
  const l = r.body.items[0];
  assert.equal(l.pricing, undefined);
  assert.equal(l.portalPassword, undefined);
  assert.equal(l.nocL2Config, undefined);
  assert.equal(l.ipAllocation, undefined);
  assert.equal(l.ipDetails, undefined);
  assert.equal(l.requirementDetails.bankDetails, undefined, 'bank details are sales/admin only');
  assert.equal(l.requirementDetails.percentageSplit, undefined, 'commercial split hidden');
  assert.equal(l.requirementDetails.userCount, 900, 'sizing stays visible');
  assert.equal(l.latitude, 18.52, 'location stays visible');
  assert.equal(l.contactPersonName, 'Meera K', 'contact stays visible');
});

test('POST /:id/feasibility stores an optional estimated delivery date', async () => {
  const lead = await createLead({ status: 'FEASIBILITY_PENDING' });
  const r = await request('POST', `/api/leads/${lead.id}/feasibility`, {
    token: tokens.feasibility,
    body: {
      feasible: true,
      vendors: [{ kind: 'OWN', fiberMeters: 500 }],
      estimatedDeliveryAt: '2026-08-01',
    },
  });
  assert.equal(r.status, 200);
  const stored = await prisma.lead.findUnique({ where: { id: lead.id }, select: { estimatedDeliveryAt: true } });
  assert.ok(stored.estimatedDeliveryAt, 'date persisted');

  const bad = await request('POST', `/api/leads/${lead.id}/feasibility`, {
    token: tokens.feasibility,
    body: { feasible: true, vendors: [{ kind: 'OWN', fiberMeters: 500 }], estimatedDeliveryAt: 'not-a-date' },
  });
  assert.equal(bad.status, 400);
});

test('store queue rows are minimal — no contact, pricing, or requirement details', async () => {
  await fullLead({ status: 'AWAITING_DISPATCH' });
  const store = await login('STORE_USER');
  const r = await request('GET', '/api/leads/store/queue', { token: store });
  const l = r.body.items[0];
  assert.equal(l.contactPersonName, undefined);
  assert.equal(l.phone, undefined);
  assert.equal(l.pricing, undefined);
  assert.equal(l.requirementDetails, undefined);
  assert.equal(l.portalPassword, undefined);
  assert.equal(l.organizationName.length > 0, true);
  assert.equal(l.city !== undefined, true, 'dispatch destination stays visible');
});

test('NOC L2 queue rows keep network data but hide money and portal creds', async () => {
  await fullLead({ status: 'NOC_L2_PENDING' });
  const r = await request('GET', '/api/leads/nocl2/queue', { token: tokens.nocL2 });
  const l = r.body.items[0];
  assert.deepEqual(l.ipDetails.entries[0].ipv4, ['203.0.113.0/24'], 'network details visible');
  assert.equal(l.nocL2Config.configType, 'PORT');
  assert.equal(l.ipAllocation.subnet, '10.1.1.0/24');
  assert.equal(l.pricing, undefined);
  assert.equal(l.portalPassword, undefined);
  assert.equal(l.requirementDetails.bankDetails, undefined);
});

test('software docs-verify rows keep docs, portal creds and RATES but hide bank details, sizing, NOC configs', async () => {
  const lead = await fullLead({ status: 'DOCS_UPLOADED' });
  await addDocument(lead.id);
  const r = await request('GET', '/api/leads/docs-verify/queue', { token: tokens.software });
  const l = r.body.items[0];
  assert.equal(l.documents.length, 1, 'documents visible to software');
  assert.equal(l.portalUsername, 'viz-co');
  assert.equal(l.portalPassword, 'super-secret', 'software manages portal creds');
  // Rates are visible to sales, software and admin only.
  assert.equal(l.pricing.ratePerMonth, 90000, 'stage-3 pricing visible to software');
  assert.equal(l.requirementDetails?.percentageSplit, 60, 'rate keys visible to software');
  assert.equal(l.nocL2Config, undefined);
  assert.equal(l.requirementDetails?.bankDetails, undefined, 'bank details still hidden');
  assert.equal(l.requirementDetails?.userCount, undefined, 'sizing not software-relevant');
});


test('sales owner keeps commercial data but not internal NOC configs', async () => {
  const lead = await fullLead({ status: 'PRICING_PENDING' });
  const r = await request('GET', `/api/leads/${lead.id}`, { token: tokens.sales });
  const l = r.body.data;
  assert.equal(l.pricing.ratePerMonth, 90000);
  assert.equal(l.requirementDetails.bankDetails.bankName, 'HDFC');
  assert.equal(l.portalUsername, 'viz-co', 'sales needs portal for handover');
  assert.equal(l.nocL2Config, undefined, 'internal NOC config hidden from sales');
  assert.equal(l.ipAllocation, undefined);
});

test('admin sees everything untouched', async () => {
  const lead = await fullLead({ status: 'PRICING_PENDING' });
  const r = await request('GET', `/api/leads/${lead.id}`, { token: tokens.admin });
  const l = r.body.data;
  assert.equal(l.pricing.ratePerMonth, 90000);
  assert.equal(l.nocL2Config.configType, 'PORT');
  assert.equal(l.portalPassword, 'super-secret');
});

test('lead documents listing is no longer open to delivery/store roles', async () => {
  const lead = await fullLead({ status: 'DELIVERY_REQ_PENDING' });
  const delivery = await login('DELIVERY_USER');
  const r = await request('GET', `/api/leads/${lead.id}/documents`, { token: delivery });
  assert.equal(r.status, 403);
});

test('stage roles see only their stages in a lead notes timeline', async () => {
  const lead = await fullLead({ status: 'FEASIBILITY_PENDING' });
  await prisma.leadNote.createMany({
    data: [
      { leadId: lead.id, stage: 'FEASIBILITY', body: 'feas note' },
      { leadId: lead.id, stage: 'PRICING', body: 'price talk' },
      { leadId: lead.id, stage: 'LEAD', body: 'created' },
    ],
  });
  const r = await request('GET', `/api/leads/${lead.id}/notes`, { token: tokens.feasibility });
  const stages = r.body.items.map((n) => n.stage).sort();
  assert.deepEqual(stages, ['FEASIBILITY', 'LEAD'], 'pricing note hidden from feasibility');

  const asSales = await request('GET', `/api/leads/${lead.id}/notes`, { token: tokens.sales });
  assert.equal(asSales.body.items.length, 3, 'sales owner sees the full timeline');
});

test('ISP lead accepts the MIX_BANDWIDTH type with a spec', async () => {
  const r = await request('POST', '/api/leads', {
    token: tokens.sales,
    body: {
      ...validLead(),
      requirementDetails: {
        bandwidthMix: ['MIX_BANDWIDTH'],
        bandwidthSpecs: { MIX_BANDWIDTH: { value: 500, unit: 'MB' } },
      },
    },
  });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.data.requirementDetails.bandwidthMix, ['MIX_BANDWIDTH']);
});

test("PUT /api/leads/:id is owner-scoped — another sales user's lead → 404", async () => {
  const otherSales = await prisma.user.upsert({
    where: { email: 'sales-other@test.local' },
    update: { isActive: true },
    create: { name: 'Other Sales', email: 'sales-other@test.local', password: 'x', role: 'SALES_USER' },
  });
  const notMine = await createLead({ assignedSalesId: otherSales.id });
  const r = await request('PUT', `/api/leads/${notMine.id}`, {
    token: tokens.sales,
    body: { ...validLead(), organizationName: 'Hijacked Name' },
  });
  assert.equal(r.status, 404, 'existence is hidden from non-owners');
  const after = await prisma.lead.findUnique({ where: { id: notMine.id }, select: { organizationName: true } });
  assert.notEqual(after.organizationName, 'Hijacked Name');

  // The owner (and admins) can still update.
  const mine = await createLead({});
  const ok = await request('PUT', `/api/leads/${mine.id}`, {
    token: tokens.sales,
    body: { ...validLead(), organizationName: 'Renamed by owner' },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.organizationName, 'Renamed by owner');
});

// Regression: BGP passed the state machine but the controller's Zod enum
// (validation/stage5.js) still rejected it — test the full HTTP path.
test('POST /:id/aggregator accepts BGP for an ISP lead end-to-end', async () => {
  const lead = await createLead({ status: 'AGGREGATOR_CONFIRM_PENDING' }); // ISP default
  const r = await request('POST', `/api/leads/${lead.id}/aggregator`, {
    token: tokens.sales,
    body: { aggregatorType: 'BGP', remark: 'BGP session' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.aggregatorType, 'BGP');
});

// ── ISP pricing: one price per bandwidth requirement, total = sum ─────────────
test('ISP pricing takes per-requirement components and totals them server-side', async () => {
  const lead = await createLead({
    status: 'PRICING_PENDING',
    requirementDetails: {
      bandwidthMix: ['PEERING', 'ILL'],
      bandwidthSpecs: { PEERING: { value: 10, unit: 'GB' }, ILL: { value: 1, unit: 'GB' } },
    },
  });
  const r = await request('POST', `/api/leads/${lead.id}/pricing`, {
    token: tokens.sales,
    body: { pricing: { components: { PEERING: 120000, ILL: '55000' }, notes: 'combo deal' } },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.pricing.ratePerMonth, 175000, 'rate = sum of components');
  assert.equal(r.body.data.pricing.finalPrice, 175000);
  assert.deepEqual(r.body.data.pricing.components, { PEERING: 120000, ILL: 55000 });
});

test('ISP pricing rejects a missing component price → 400 naming the requirement', async () => {
  const lead = await createLead({
    status: 'PRICING_PENDING',
    requirementDetails: {
      bandwidthMix: ['PEERING', 'ILL'],
      bandwidthSpecs: { PEERING: { value: 10, unit: 'GB' }, ILL: { value: 1, unit: 'GB' } },
    },
  });
  const r = await request('POST', `/api/leads/${lead.id}/pricing`, {
    token: tokens.sales,
    body: { pricing: { components: { PEERING: 120000 } } },
  });
  assert.equal(r.status, 400);
  assert.ok(JSON.stringify(r.body.errors).includes('ILL'), 'names the unpriced requirement');
});

test('non-ISP pricing keeps the single rate + discount shape', async () => {
  const lead = await createLead({
    status: 'PRICING_PENDING',
    category: 'PIN_RATE',
    requirementDetails: { estimatedUserCount: 100, ratePerUser: 40 },
  });
  const r = await request('POST', `/api/leads/${lead.id}/pricing`, {
    token: tokens.sales,
    body: { pricing: { ratePerMonth: 10000, discountPercentage: 10 } },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.pricing.finalPrice, 9000);
});

// NOC L3 can close the handoff too (with a note) — not just the assigned L2.
test('POST /:id/l3-to-l2 allows the NOC L3 user to mark the handoff completed', async () => {
  const nocL3 = await login('NOC_L3_USER');
  const lead = await createLead({ status: 'L3_TO_L2_HANDOFF' });
  const r = await request('POST', `/api/leads/${lead.id}/l3-to-l2`, {
    token: nocL3,
    body: { notes: 'Verified with L2 on call — closing from L3 side' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.status, 'CLIENT_HANDOVER_PENDING');
});

// ── Aggregator options (stage-10 picker) ─────────────────────────────────────
test('GET /api/leads/aggregator-options returns builtins + custom master rows', async () => {
  await prisma.aggregatorType.create({ data: { name: 'OLT', createdById: userId('SALES_USER') } });
  const r = await request('GET', '/api/leads/aggregator-options', { token: tokens.sales });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.builtins, ['BNG', 'MIKROTIK', 'BGP']);
  assert.deepEqual(r.body.custom, ['OLT']);

  const unauth = await request('GET', '/api/leads/aggregator-options');
  assert.equal(unauth.status, 401);
});
