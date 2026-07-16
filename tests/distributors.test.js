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
  const noPick = await request('POST', '/api/leads', { token: tokens.sales, body: validLead() });
  assert.equal(noPick.status, 201);
  const gazon = await prisma.distributor.findFirst({ where: { isDefault: true } });
  assert.ok(gazon, 'GAZON exists after first creation');
  assert.equal(noPick.body.data.distributorId, gazon.id);

  const dist = await prisma.distributor.create({ data: { name: 'North Head', phone: '9111111111' } });
  const picked = await request('POST', '/api/leads', {
    token: tokens.sales,
    body: validLead({ email: 'b@acme.test', phone: '9876500001', whatsappNumber: '9876500001', distributorId: dist.id }),
  });
  assert.equal(picked.status, 201);
  assert.equal(picked.body.data.distributorId, dist.id);

  const bogus = await request('POST', '/api/leads', {
    token: tokens.sales,
    body: validLead({ email: 'c@acme.test', phone: '9876500002', whatsappNumber: '9876500002', distributorId: '00000000-0000-4000-8000-000000000000' }),
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

test('isDefault on create/edit swaps the single default; unsetting directly is refused', async () => {
  await request('GET', '/api/distributors/options', { token: tokens.admin }); // seeds GAZON default
  const gazon = await prisma.distributor.findFirst({ where: { isDefault: true } });

  // Create a new distributor as the default → GAZON loses the flag.
  const created = await request('POST', '/api/distributors', {
    token: tokens.admin,
    body: { name: 'My Own HQ', phone: '9777777777', isDefault: true },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.isDefault, true);
  const defaults = await prisma.distributor.findMany({ where: { isDefault: true } });
  assert.equal(defaults.length, 1, 'exactly one default at all times');
  assert.equal(defaults[0].id, created.body.data.id);

  // The demoted GAZON is now a normal row — deletable.
  const delOld = await request('DELETE', `/api/distributors/${gazon.id}`, { token: tokens.admin });
  assert.equal(delOld.status, 200);

  // Promote another via edit → swaps again.
  const other = await prisma.distributor.create({ data: { name: 'Backup HQ' } });
  const promoted = await request('PUT', `/api/distributors/${other.id}`, {
    token: tokens.admin,
    body: { name: 'Backup HQ', isDefault: true },
  });
  assert.equal(promoted.status, 200);
  assert.equal(promoted.body.data.isDefault, true);
  assert.equal(await prisma.distributor.count({ where: { isDefault: true } }), 1);

  // Unsetting the default directly is refused — promote another instead.
  const unset = await request('PUT', `/api/distributors/${other.id}`, {
    token: tokens.admin,
    body: { name: 'Backup HQ', isDefault: false },
  });
  assert.equal(unset.status, 400);

  // Fallback of unassigned leads follows the CURRENT default.
  const lead = await createLead(); // distributorId null
  const leads = await request('GET', `/api/distributors/${other.id}/leads`, { token: tokens.admin });
  assert.ok(leads.body.items.some((l) => l.id === lead.id), 'null-distributor leads belong to the current default');
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
