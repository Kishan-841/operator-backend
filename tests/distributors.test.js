import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import app from '../src/app.js';
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
    /* empty */
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
    const r = await request('POST', '/api/auth/login', {
      body: { email: `${role.toLowerCase()}@test.local`, password: TEST_PASSWORD },
    });
    return r.body?.token;
  };
  tokens.admin = await login('ADMIN');
  tokens.sales = await login('SALES_USER');
});

beforeEach(cleanup);

after(async () => {
  await cleanup();
  await new Promise((res) => server.close(res));
  await prisma.$disconnect();
});

const validLead = (extra = {}) => ({
  category: 'ISP',
  organizationName: 'Acme Telecom',
  email: 'ops@acme.test',
  phone: '9876543210',
  whatsappNumber: '9876543210',
  requirementDetails: { bandwidthMix: ['ILL'], bandwidthSpecs: { ILL: { value: 100, unit: 'MB' } } },
  ...extra,
});

test('options endpoint seeds GAZON, orders it first, and is open to sales', async () => {
  const r = await request('GET', '/api/distributors/options', { token: tokens.sales });
  assert.equal(r.status, 200);
  assert.equal(r.body.items[0].name, 'GAZON');
  assert.equal(r.body.items[0].isDefault, true);
});

test('lead without a distributor lands under GAZON; explicit pick is stored; bogus id → 400', async () => {
  // Distributor applies to non-ISP leads (ISP carries no distributor), so this
  // exercises the default/pick/validation with a PIN_RATE lead.
  const pinLead = (extra = {}) => ({
    category: 'PIN_RATE',
    organizationName: 'Pin Co',
    email: 'pin@acme.test',
    phone: '9876543210',
    whatsappNumber: '9876543210',
    requirementDetails: { estimatedUserCount: 100, ratePerUser: 40 },
    ...extra,
  });

  const noPick = await request('POST', '/api/leads', { token: tokens.sales, body: pinLead() });
  assert.equal(noPick.status, 201);
  const gazon = await prisma.distributor.findFirst({ where: { isDefault: true } });
  assert.ok(gazon, 'GAZON exists after first creation');
  assert.equal(noPick.body.data.distributorId, gazon.id);

  const dist = await prisma.distributor.create({ data: { name: 'North Head', phone: '9111111111' } });
  const picked = await request('POST', '/api/leads', {
    token: tokens.sales,
    body: pinLead({ email: 'b@acme.test', phone: '9876500001', whatsappNumber: '9876500001', distributorId: dist.id }),
  });
  assert.equal(picked.status, 201);
  assert.equal(picked.body.data.distributorId, dist.id);

  const bogus = await request('POST', '/api/leads', {
    token: tokens.sales,
    body: pinLead({ email: 'c@acme.test', phone: '9876500002', whatsappNumber: '9876500002', distributorId: '00000000-0000-4000-8000-000000000000' }),
  });
  assert.equal(bogus.status, 400);
});

test('distributor CRUD is admin-only; sales can only read options', async () => {
  const list = await request('GET', '/api/distributors', { token: tokens.sales });
  assert.equal(list.status, 403);
  const create = await request('POST', '/api/distributors', { token: tokens.sales, body: { name: 'X Head' } });
  assert.equal(create.status, 403);
});

test('full operator-shaped payload creates a distributor with a stored profile', async () => {
  const body = validLead({
    organizationName: 'West Region Head',
    email: 'west@dist.test',
    phone: '9444444444',
    whatsappNumber: '9444444444',
    category: 'PIN_RATE',
    requirementDetails: { estimatedUserCount: 100, ratePerUser: 50 },
  });
  const r = await request('POST', '/api/distributors', { token: tokens.admin, body });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.name, 'West Region Head');
  assert.equal(r.body.data.phone, '9444444444');
  assert.equal(r.body.data.email, 'west@dist.test');
  assert.equal(r.body.data.profile.category, 'PIN_RATE');
  assert.equal(r.body.data.profile.requirementDetails.ratePerUser, 50);

  // Invalid full payload (bad email) → 400 with field errors, like leads.
  const bad = await request('POST', '/api/distributors', {
    token: tokens.admin,
    body: validLead({ organizationName: 'X', email: 'not-an-email', phone: '9444444445', whatsappNumber: '9444444445' }),
  });
  assert.equal(bad.status, 400);
  assert.ok(Array.isArray(bad.body.errors));

  // Editing with a full payload updates profile + extracted columns.
  const upd = await request('PUT', `/api/distributors/${r.body.data.id}`, {
    token: tokens.admin,
    body: { ...body, organizationName: 'West Head Renamed' },
  });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.data.name, 'West Head Renamed');
  assert.equal(upd.body.data.profile.organizationName, 'West Head Renamed');
});

test('a PIN_RATE distributor saves without the prospect metrics (leads still require them)', async () => {
  const body = {
    category: 'PIN_RATE',
    organizationName: 'Metric-less Head',
    email: 'nometrics@dist.test',
    phone: '9666600001',
    whatsappNumber: '9666600001',
    requirementDetails: {}, // no estimatedUserCount / ratePerUser — hidden for distributors
  };
  const r = await request('POST', '/api/distributors', { token: tokens.admin, body });
  assert.equal(r.status, 201, 'distributor accepts an empty PIN_RATE requirement blob');
  assert.equal(r.body.data.profile.category, 'PIN_RATE');

  // The same payload as a LEAD is still rejected — the pipeline needs the metrics.
  const asLead = await request('POST', '/api/leads', {
    token: tokens.sales,
    body: { ...body, email: 'lead@x.test', phone: '9666600002', whatsappNumber: '9666600002' },
  });
  assert.equal(asLead.status, 400, 'leads still require estimatedUserCount / ratePerUser');
});

test('duplicate distributor mobile/email → 400 naming the existing one', async () => {
  const first = await request('POST', '/api/distributors', {
    token: tokens.admin,
    body: { name: 'North Head', phone: '9111111111', email: 'north@dist.test' },
  });
  assert.equal(first.status, 201);
  const dupPhone = await request('POST', '/api/distributors', {
    token: tokens.admin,
    body: { name: 'Other', phone: '9111111111' },
  });
  assert.equal(dupPhone.status, 400);
  assert.match(dupPhone.body.message, /North Head/);
  const dupEmail = await request('POST', '/api/distributors', {
    token: tokens.admin,
    body: { name: 'Other', email: 'NORTH@dist.test' },
  });
  assert.equal(dupEmail.status, 400);
});

test('the default cannot be deleted; deleting others reassigns franchises to the default', async () => {
  await request('GET', '/api/distributors/options', { token: tokens.admin }); // ensures a default
  const gazon = await prisma.distributor.findFirst({ where: { isDefault: true } });

  const del = await request('DELETE', `/api/distributors/${gazon.id}`, { token: tokens.admin });
  assert.equal(del.status, 400);

  // The default is user-managed now — renaming it is allowed.
  const rename = await request('PUT', `/api/distributors/${gazon.id}`, {
    token: tokens.admin,
    body: { name: 'Gazon HQ' },
  });
  assert.equal(rename.status, 200);
  assert.equal(rename.body.data.name, 'Gazon HQ');

  // Deleting a real distributor reassigns its franchises to the default.
  const dist = await prisma.distributor.create({ data: { name: 'South Head' } });
  const lead = await createLead({ distributorId: dist.id });
  const gone = await request('DELETE', `/api/distributors/${dist.id}`, { token: tokens.admin });
  assert.equal(gone.status, 200);
  const moved = await prisma.lead.findUnique({ where: { id: lead.id }, select: { distributorId: true } });
  assert.equal(moved.distributorId, gazon.id);
});

test('isDefault in request bodies is ignored — the default cannot be changed via the API', async () => {
  await request('GET', '/api/distributors/options', { token: tokens.admin }); // seeds the default
  const gazon = await prisma.distributor.findFirst({ where: { isDefault: true } });

  // Creating with isDefault: true does NOT create a new default.
  const created = await request('POST', '/api/distributors', {
    token: tokens.admin,
    body: { name: 'My Own HQ', phone: '9777777777', isDefault: true },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.isDefault, false, 'flag ignored on create');

  // Editing with isDefault: true does not promote either.
  const promoted = await request('PUT', `/api/distributors/${created.body.data.id}`, {
    token: tokens.admin,
    body: { name: 'My Own HQ', phone: '9777777777', isDefault: true },
  });
  assert.equal(promoted.status, 200);
  assert.equal(promoted.body.data.isDefault, false, 'flag ignored on edit');

  // Editing the default with isDefault: false doesn't strip it.
  const unset = await request('PUT', `/api/distributors/${gazon.id}`, {
    token: tokens.admin,
    body: { name: gazon.name, isDefault: false },
  });
  assert.equal(unset.status, 200);
  const still = await prisma.distributor.findUnique({ where: { id: gazon.id }, select: { isDefault: true } });
  assert.equal(still.isDefault, true, 'default flag untouched');
  assert.equal(await prisma.distributor.count({ where: { isDefault: true } }), 1);
});

test('distributor list carries franchise counts; GAZON counts null-distributor leads', async () => {
  await request('GET', '/api/distributors/options', { token: tokens.admin });
  const gazon = await prisma.distributor.findFirst({ where: { isDefault: true } });
  const dist = await prisma.distributor.create({ data: { name: 'East Head' } });
  await createLead(); // distributorId null → GAZON's
  await createLead({ distributorId: gazon.id });
  await createLead({ distributorId: dist.id });

  const r = await request('GET', '/api/distributors', { token: tokens.admin });
  assert.equal(r.status, 200);
  const byName = Object.fromEntries(r.body.items.map((d) => [d.name, d.franchiseCount]));
  assert.equal(byName.GAZON, 2);
  assert.equal(byName['East Head'], 1);

  // GAZON's franchise list includes the null-distributor lead.
  const leads = await request('GET', `/api/distributors/${gazon.id}/leads`, { token: tokens.admin });
  assert.equal(leads.status, 200);
  assert.equal(leads.body.items.length, 2);
});

// ── POST /api/distributors/bulk (Excel import) ───────────────────────────────
const distRow = (over = {}) => ({
  _sheet: 'Pin Rate', _row: 2,
  category: 'PIN_RATE',
  organizationName: 'Head Franchise A',
  email: 'head-a@dist.test',
  whatsappNumber: '9876543210',
  phone: '9811111111',
  requirementDetails: {},
  ...over,
});

test('bulk distributor import creates the valid rows', async () => {
  const r = await request('POST', '/api/distributors/bulk', {
    token: tokens.admin,
    body: { rows: [
      distRow({ email: 'bd-a@dist.test', whatsappNumber: '9990000001', phone: '9990000002' }),
      distRow({ email: 'bd-b@dist.test', whatsappNumber: '9990000003', phone: '9990000004', organizationName: 'Head B' }),
    ] },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.created, 2);
  assert.equal(r.body.errors.length, 0);
  const made = await prisma.distributor.findFirst({ where: { email: 'bd-a@dist.test' } });
  assert.ok(made, 'distributor stored');
  assert.equal(made.name, 'Head Franchise A');
});

test('bulk distributor import skips a row duplicating an existing email and names the field', async () => {
  await request('POST', '/api/distributors/bulk', {
    token: tokens.admin,
    body: { rows: [distRow({ email: 'dupe@dist.test', whatsappNumber: '9992220001', phone: '9992220002' })] },
  });
  const r = await request('POST', '/api/distributors/bulk', {
    token: tokens.admin,
    body: { rows: [
      distRow({ email: 'dupe@dist.test', whatsappNumber: '9992220005', phone: '9992220006' }),
      distRow({ email: 'fresh@dist.test', whatsappNumber: '9992220007', phone: '9992220008' }),
    ] },
  });
  assert.equal(r.body.created, 1);
  assert.equal(r.body.skipped, 1);
  assert.equal(r.body.duplicates.length, 1);
  assert.match(r.body.duplicates[0].reason, /email/i);
});

test('bulk distributor import de-duplicates a repeated phone within the file', async () => {
  const r = await request('POST', '/api/distributors/bulk', {
    token: tokens.admin,
    body: { rows: [
      distRow({ email: 'p1@dist.test', whatsappNumber: '9993330001', phone: '9993330009' }),
      distRow({ email: 'p2@dist.test', whatsappNumber: '9993330003', phone: '9993330009' }),
    ] },
  });
  assert.equal(r.body.created, 1);
  assert.equal(r.body.skipped, 1);
  assert.match(r.body.duplicates[0].reason, /mobile|phone/i);
});

test('bulk distributor import reports an invalid row with its sheet and row', async () => {
  const r = await request('POST', '/api/distributors/bulk', {
    token: tokens.admin,
    body: { rows: [
      distRow({ email: 'ok@dist.test', whatsappNumber: '9994440001', phone: '9994440002' }),
      distRow({ _sheet: 'Pin Rate', _row: 9, organizationName: '', email: 'bad@dist.test', whatsappNumber: '9994440003', phone: '9994440004' }),
    ] },
  });
  assert.equal(r.body.created, 1);
  assert.equal(r.body.errors.length, 1);
  assert.equal(r.body.errors[0].row, 9);
});

test('bulk distributor import is forbidden for a non-admin → 403', async () => {
  const r = await request('POST', '/api/distributors/bulk', {
    token: tokens.sales,
    body: { rows: [distRow()] },
  });
  assert.equal(r.status, 403);
});

// ── Dual-role: creating a distributor also creates its franchise-lead ─────────
const fullDist = (over = {}) => ({
  category: 'PIN_RATE',
  organizationName: 'Dual Head',
  email: 'dual@dist.test',
  whatsappNumber: '9876543210',
  phone: '9811111111',
  requirementDetails: {},
  ...over,
});

test('creating a distributor also creates a linked franchise-lead at NEW', async () => {
  const r = await request('POST', '/api/distributors', {
    token: tokens.admin,
    body: fullDist({ email: 'df-a@dist.test', phone: '9990000011', whatsappNumber: '9990000011' }),
  });
  assert.equal(r.status, 201);
  const distId = r.body.data.id;
  const lead = await prisma.lead.findFirst({ where: { email: 'df-a@dist.test' } });
  assert.ok(lead, 'franchise-lead created');
  assert.equal(lead.distributorId, distId, 'lead is linked to the distributor');
  assert.equal(lead.status, 'NEW');
});

test('creating a distributor for a business that is already a lead links the existing lead', async () => {
  // A PIN_RATE lead already exists for this contact.
  await request('POST', '/api/leads', {
    token: tokens.sales,
    body: { category: 'PIN_RATE', organizationName: 'Already Lead', email: 'already@dist.test',
      whatsappNumber: '9990000021', phone: '9990000022',
      requirementDetails: { estimatedUserCount: 100, ratePerUser: 40 } },
  });
  const before = await prisma.lead.count({ where: { email: 'already@dist.test' } });
  assert.equal(before, 1);

  const r = await request('POST', '/api/distributors', {
    token: tokens.admin,
    body: fullDist({ organizationName: 'Already Lead', email: 'already@dist.test', phone: '9990000022', whatsappNumber: '9990000021' }),
  });
  assert.equal(r.status, 201);
  const after = await prisma.lead.count({ where: { email: 'already@dist.test' } });
  assert.equal(after, 1, 'no duplicate lead — the existing one was reused');
  const lead = await prisma.lead.findFirst({ where: { email: 'already@dist.test' } });
  assert.equal(lead.distributorId, r.body.data.id, 'existing lead now linked to the new distributor');
});
