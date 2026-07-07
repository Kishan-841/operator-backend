import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import app from '../src/app.js';
import { prisma, seedUsers, cleanup, TEST_PASSWORD, createLead, addLog, userId } from './helpers.mjs';

let server;
let base;
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
const tokens = {};

before(async () => {
  await seedUsers();
  await cleanup();
  server = app.listen(0);
  await new Promise((res) => server.once('listening', res));
  base = `http://127.0.0.1:${server.address().port}`;
  tokens.sales = await login('SALES_USER');
  tokens.feasibility = await login('FEASIBILITY_USER');
  tokens.software = await login('SOFTWARE_USER');
  tokens.admin = await login('ADMIN');
});
beforeEach(cleanup);
after(async () => {
  await cleanup();
  await new Promise((res) => server.close(res));
  await prisma.$disconnect();
});

test('GET /api/reports/my-dashboard requires auth', async () => {
  const r = await request('GET', '/api/reports/my-dashboard');
  assert.equal(r.status, 401);
});

test('my-dashboard returns role, normalized window, and arrays', async () => {
  const r = await request('GET', '/api/reports/my-dashboard?window=bogus', { token: tokens.sales });
  assert.equal(r.status, 200);
  assert.equal(r.body.role, 'SALES_USER');
  assert.equal(r.body.window, '30d'); // bogus → default
  assert.ok(Array.isArray(r.body.kpis));
  assert.ok(Array.isArray(r.body.recent));
});

test('sales: leadsCreated, winRate, and pipelineValue reflect my owned leads', async () => {
  const me = userId('SALES_USER');
  // 2 leads created by me, recently
  await createLead({ createdById: me, status: 'PRICING_PENDING', pricing: { ratePerMonth: 5000 } });
  await createLead({ createdById: me, status: 'PENDING_APPROVAL', pricing: { ratePerMonth: 3000 } });
  // a completed (won) and a rejected (lost) lead, with terminal logs in-window
  const won = await createLead({ createdById: me, status: 'COMPLETED' });
  await addLog({ changedById: userId('SOFTWARE_USER'), entityId: won.id, oldValue: 'AGREEMENT_PENDING', newValue: 'COMPLETED' });
  const lost = await createLead({ createdById: me, status: 'REJECTED' });
  await addLog({ changedById: userId('FEASIBILITY_USER'), entityId: lost.id, oldValue: 'FEASIBILITY_PENDING', newValue: 'REJECTED' });

  const res = await fetch(base + '/api/reports/my-dashboard?window=30d', { headers: { Authorization: `Bearer ${tokens.sales}` } });
  const body = await res.json();
  const kpi = (k) => body.kpis.find((x) => x.key === k);
  assert.equal(kpi('leadsCreated').value, 4);
  assert.equal(kpi('winRate').value, 50); // 1 won / (1 won + 1 lost)
  assert.equal(kpi('pipelineValue').value, 8000); // 5000 + 3000 (active only)
  assert.ok(body.breakdown && body.breakdown.title === 'My deal mix');
});

test('feasibility: reviewsDone and feasibleRate reflect my reviews', async () => {
  const me = userId('FEASIBILITY_USER');
  const a = await createLead({ status: 'PRICING_PENDING' });
  const b = await createLead({ status: 'PRICING_PENDING' });
  const c = await createLead({ status: 'REJECTED' });
  await addLog({ changedById: me, entityId: a.id, oldValue: 'FEASIBILITY_PENDING', newValue: 'PRICING_PENDING' });
  await addLog({ changedById: me, entityId: b.id, oldValue: 'FEASIBILITY_PENDING', newValue: 'PRICING_PENDING' });
  await addLog({ changedById: me, entityId: c.id, oldValue: 'FEASIBILITY_PENDING', newValue: 'REJECTED' });

  const res = await fetch(base + '/api/reports/my-dashboard', { headers: { Authorization: `Bearer ${tokens.feasibility}` } });
  const body = await res.json();
  const kpi = (k) => body.kpis.find((x) => x.key === k);
  assert.equal(kpi('reviewsDone').value, 3);
  assert.equal(kpi('feasibleRate').value, 67); // 2 of 3
});

test('window filtering: a review older than 7d is excluded by window=7d', async () => {
  const me = userId('FEASIBILITY_USER');
  const old = await createLead({ status: 'PRICING_PENDING' });
  await addLog({ changedById: me, entityId: old.id, oldValue: 'FEASIBILITY_PENDING', newValue: 'PRICING_PENDING', createdAt: new Date(Date.now() - 20 * 86400000) });

  const wk = await (await fetch(base + '/api/reports/my-dashboard?window=7d', { headers: { Authorization: `Bearer ${tokens.feasibility}` } })).json();
  const all = await (await fetch(base + '/api/reports/my-dashboard?window=all', { headers: { Authorization: `Bearer ${tokens.feasibility}` } })).json();
  const reviews = (b) => b.kpis.find((x) => x.key === 'reviewsDone').value;
  assert.equal(reviews(wk), 0); // 20d-old review excluded from 7d
  assert.equal(reviews(all), 1); // included in all-time
});

test('software: docsVerified counts my DOC_VERIFIED logs', async () => {
  const me = userId('SOFTWARE_USER');
  const lead = await createLead({ status: 'SOFTWARE_PENDING' });
  await addLog({ changedById: me, action: 'DOC_VERIFIED', entityId: lead.id });
  await addLog({ changedById: me, action: 'DOC_VERIFIED', entityId: lead.id });
  await addLog({ changedById: me, action: 'DOC_REJECTED', entityId: lead.id });

  const res = await fetch(base + '/api/reports/my-dashboard', { headers: { Authorization: `Bearer ${tokens.software}` } });
  const body = await res.json();
  const kpi = (k) => body.kpis.find((x) => x.key === k);
  assert.equal(kpi('docsVerified').value, 2);
  assert.equal(body.breakdown.segments.find((s) => s.label === 'Rejected').value, 1);
});

test('delivery: requisitions + installs count my transitions', async () => {
  const me = userId('DELIVERY_USER');
  const x = await createLead({ status: 'AWAITING_DISPATCH' });
  const y = await createLead({ status: 'NOC_L2_PENDING' });
  await addLog({ changedById: me, entityId: x.id, oldValue: 'DELIVERY_REQ_PENDING', newValue: 'AWAITING_DISPATCH' });
  await addLog({ changedById: me, entityId: y.id, oldValue: 'DISPATCHED', newValue: 'NOC_L2_PENDING' });

  const res = await fetch(base + '/api/reports/my-dashboard', { headers: { Authorization: `Bearer ${await login('DELIVERY_USER')}` } });
  const body = await res.json();
  const kpi = (k) => body.kpis.find((x) => x.key === k);
  assert.equal(kpi('requisitionsRaised').value, 1);
  assert.equal(kpi('installsCompleted').value, 1);
});

test('overview includes totalPipelineValue and workloadByTeam', async () => {
  await createLead({ status: 'PRICING_PENDING', pricing: { ratePerMonth: 4000 } });
  await createLead({ status: 'FEASIBILITY_PENDING' });
  const res = await fetch(base + '/api/reports/overview', { headers: { Authorization: `Bearer ${tokens.admin}` } });
  const body = await res.json();
  assert.equal(body.totalPipelineValue, 4000);
  assert.ok(Array.isArray(body.workloadByTeam));
  const feas = body.workloadByTeam.find((w) => w.status === 'FEASIBILITY_PENDING');
  assert.ok(feas && feas.count >= 1 && feas.href === '/dashboard/feasibility-queue');
});

test('overview revenue: MRR + per-operator value from onboarded leads (finalPrice wins)', async () => {
  const me = userId('SOFTWARE_USER');
  // A: discounted price, onboarded exactly 2 (pro-rata) months ago.
  const a = await createLead({
    status: 'COMPLETED',
    category: 'PIN_RATE',
    pricing: { ratePerMonth: 5000, discountPercentage: 10, finalPrice: 4500 },
  });
  await addLog({
    changedById: me, entityId: a.id, oldValue: 'AGREEMENT_PENDING', newValue: 'COMPLETED',
    createdAt: new Date(Date.now() - 2 * 30.44 * 24 * 60 * 60 * 1000),
  });
  // B: no finalPrice (older lead) — falls back to ratePerMonth; onboarded now.
  const b = await createLead({ status: 'COMPLETED', pricing: { ratePerMonth: 2000 } });
  await addLog({
    changedById: me, entityId: b.id, oldValue: 'AGREEMENT_PENDING', newValue: 'COMPLETED',
  });
  // Active lead with pricing must NOT count toward revenue.
  await createLead({ status: 'PRICING_PENDING', pricing: { ratePerMonth: 9999 } });

  const res = await fetch(base + '/api/reports/overview', { headers: { Authorization: `Bearer ${tokens.admin}` } });
  const { revenue } = await res.json();

  assert.equal(revenue.onboardedCount, 2);
  assert.equal(revenue.mrr, 6500); // 4500 (discounted) + 2000
  assert.equal(revenue.avgValue, 3250);
  // estCollected ≈ 4500 × 2 months + 2000 × ~0 months.
  assert.ok(Math.abs(revenue.estCollected - 9000) < 60, `estCollected=${revenue.estCollected}`);
  // Operators sorted by value, carrying their onboarding date.
  assert.equal(revenue.operators[0].id, a.id);
  assert.equal(revenue.operators[0].monthlyValue, 4500);
  assert.ok(revenue.operators[0].onboardedAt);
  // Category split.
  const pin = revenue.byCategory.find((c) => c.category === 'PIN_RATE');
  assert.deepEqual({ mrr: pin.mrr, count: pin.count }, { mrr: 4500, count: 1 });
});

test('overview revenue growth buckets onboardings and accumulates MRR', async () => {
  const me = userId('SOFTWARE_USER');
  const old = await createLead({ status: 'COMPLETED', pricing: { finalPrice: 3000, ratePerMonth: 3000 } });
  await addLog({
    changedById: me, entityId: old.id, oldValue: 'AGREEMENT_PENDING', newValue: 'COMPLETED',
    createdAt: new Date(Date.now() - 3 * 30.44 * 24 * 60 * 60 * 1000),
  });
  const fresh = await createLead({ status: 'COMPLETED', pricing: { finalPrice: 1000, ratePerMonth: 1000 } });
  await addLog({
    changedById: me, entityId: fresh.id, oldValue: 'AGREEMENT_PENDING', newValue: 'COMPLETED',
  });

  const res = await fetch(base + '/api/reports/overview', { headers: { Authorization: `Bearer ${tokens.admin}` } });
  const { revenue } = await res.json();

  assert.equal(revenue.growth.length, 12);
  const last = revenue.growth[revenue.growth.length - 1];
  assert.ok(last.onboarded >= 1, 'current month counts the fresh onboarding');
  assert.equal(last.cumulativeMrr, 4000, 'curve ends at full MRR');
  assert.equal(revenue.newThisMonth, 1);
});

// ── Lead metrics: not-feasible + per-sales-user split inside each category ───
test('lead-metrics reports notFeasible and a per-sales-user split per category', async () => {
  const me = userId('SALES_USER');
  const other = await prisma.user.upsert({
    where: { email: 'sales-two@test.local' },
    update: { isActive: true },
    create: { name: 'Sales Two', email: 'sales-two@test.local', password: 'x', role: 'SALES_USER' },
  });
  // Two ISP leads for me (one rejected), one PIN_RATE lead for the other user.
  await createLead({ assignedSalesId: me, status: 'COMPLETED' }); // ISP (helper default)
  await createLead({ assignedSalesId: me, status: 'REJECTED' }); // ISP, not feasible
  await createLead({
    assignedSalesId: other.id,
    status: 'PRICING_PENDING',
    category: 'PIN_RATE',
    requirementDetails: { estimatedUserCount: 500, ratePerUser: 40 },
  });

  const res = await fetch(base + '/api/reports/lead-metrics', { headers: { Authorization: `Bearer ${tokens.admin}` } });
  const body = await res.json();

  assert.equal(body.overall.leads, 3);
  assert.equal(body.overall.notFeasible, 1);

  const isp = body.byCategory.find((c) => c.category === 'ISP');
  assert.equal(isp.leads, 2);
  assert.equal(isp.notFeasible, 1);
  const mine = isp.bySalesUser.find((u) => u.id === me);
  assert.equal(mine.leads, 2);
  assert.equal(mine.converted, 1);
  assert.equal(mine.notFeasible, 1);
  const theirsInIsp = isp.bySalesUser.find((u) => u.id === other.id);
  assert.equal(theirsInIsp.leads, 0);

  const pinRate = body.byCategory.find((c) => c.category === 'PIN_RATE');
  const theirs = pinRate.bySalesUser.find((u) => u.id === other.id);
  assert.equal(theirs.leads, 1);
  assert.equal(theirs.notFeasible, 0);
});

// ── Operator map: coordinates on revenue.operators ───────────────────────────
test('overview operators carry coords — own lat/long, pincode fallback, 0,0 filtered', async () => {
  const me = userId('SALES_USER');
  await prisma.pincode.deleteMany({ where: { pincode: '999001' } });
  await prisma.pincode.create({
    data: { pincode: '999001', officeName: 'Test PO', district: 'TESTVILLE', state: 'Testland', latitude: 18.52, longitude: 73.85 },
  });

  const own = await createLead({
    assignedSalesId: me, status: 'COMPLETED', latitude: 26.9124, longitude: 75.7873,
  });
  const viaPincode = await createLead({
    assignedSalesId: me, status: 'COMPLETED', latitude: 0, longitude: 0, pincode: '999001',
  });
  const nowhere = await createLead({ assignedSalesId: me, status: 'COMPLETED' });

  const res = await fetch(base + '/api/reports/overview', { headers: { Authorization: `Bearer ${tokens.admin}` } });
  const { revenue } = await res.json();
  const byId = Object.fromEntries(revenue.operators.map((o) => [o.id, o]));

  assert.equal(byId[own.id].latitude, 26.9124);
  assert.equal(byId[own.id].longitude, 75.7873);
  assert.equal(byId[viaPincode.id].latitude, 18.52, '0,0 sentinel falls back to the pincode coords');
  assert.equal(byId[viaPincode.id].longitude, 73.85);
  assert.equal(byId[nowhere.id].latitude, null);
  assert.equal(byId[nowhere.id].longitude, null);
});
