import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import app from '../src/app.js';
import { prisma, seedUsers, cleanup, TEST_PASSWORD, createLead } from './helpers.mjs';

let server;
let base;
const tokens = {};

const request = async (method, path, { token } = {}) => {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(base + path, { method, headers });
  let body = null;
  try { body = await res.json(); } catch { /* empty */ }
  return { status: res.status, body };
};
const login = async (role) => {
  const r = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `${role.toLowerCase()}@test.local`, password: TEST_PASSWORD }),
  });
  return (await r.json()).token;
};

before(async () => {
  await seedUsers();
  await cleanup();
  server = app.listen(0);
  await new Promise((res) => server.once('listening', res));
  base = `http://127.0.0.1:${server.address().port}`;
  tokens.admin = await login('ADMIN');
  tokens.sales = await login('SALES_USER');
});
beforeEach(cleanup);
after(async () => {
  await cleanup();
  await new Promise((res) => server.close(res));
  await prisma.$disconnect();
});

test('GET /api/map requires auth → 401', async () => {
  const r = await request('GET', '/api/map');
  assert.equal(r.status, 401);
});

test('GET /api/map forbidden for a non-admin role → 403', async () => {
  const r = await request('GET', '/api/map', { token: tokens.sales });
  assert.equal(r.status, 403);
});

test('GET /api/map returns only leads with valid own coordinates', async () => {
  await createLead({ organizationName: 'Has coords', latitude: 18.5204, longitude: 73.8567 });
  await createLead({ organizationName: 'No coords', latitude: null, longitude: null });
  await createLead({ organizationName: 'Half coords', latitude: 18.52, longitude: null });
  await createLead({ organizationName: 'Zero sentinel', latitude: 0, longitude: 0 });
  await createLead({ organizationName: 'Out of range', latitude: 500, longitude: 1000 });

  const r = await request('GET', '/api/map', { token: tokens.admin });
  assert.equal(r.status, 200);
  const names = r.body.items.map((l) => l.organizationName).sort();
  assert.deepEqual(names, ['Has coords']);
  const only = r.body.items[0];
  assert.equal(only.latitude, 18.5204);
  assert.equal(only.longitude, 73.8567);
  assert.equal(only.progress, 'NEW');
  assert.ok('leadNumber' in only && 'category' in only && 'ownerName' in only);
});

test('GET /api/map derives progress from canonical status', async () => {
  const coords = { latitude: 19.076, longitude: 72.8777 };
  await createLead({ organizationName: 'New lead', status: 'NEW', ...coords });
  await createLead({ organizationName: 'In feasibility', status: 'FEASIBILITY_PENDING', ...coords });
  await createLead({ organizationName: 'Deep pipeline', status: 'NOC_L3_PENDING', ...coords });
  await createLead({ organizationName: 'Done', status: 'COMPLETED', ...coords });
  await createLead({ organizationName: 'Dead', status: 'REJECTED', ...coords });

  const r = await request('GET', '/api/map', { token: tokens.admin });
  const byName = Object.fromEntries(r.body.items.map((l) => [l.organizationName, l.progress]));
  assert.equal(byName['New lead'], 'NEW');
  assert.equal(byName['In feasibility'], 'IN_PROGRESS');
  assert.equal(byName['Deep pipeline'], 'IN_PROGRESS');
  assert.equal(byName['Done'], 'COMPLETED');
  assert.equal(byName['Dead'], 'REJECTED');
});
