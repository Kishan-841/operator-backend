import { test, before, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import jwt from 'jsonwebtoken';
import { io as ioClient } from 'socket.io-client';
import app from '../src/app.js';
import { initializeSocket, notifyUser, broadcastSidebarRefresh } from '../src/sockets/index.js';
import * as sm from '../src/services/leadStateMachine.js';
import { prisma, seedUsers, createLead, cleanup } from './helpers.mjs';

let httpServer;
let url;
let users;
let clients = [];

const tokenFor = (role) =>
  jwt.sign({ userId: users[role].id, role }, process.env.JWT_SECRET, { expiresIn: '1h' });

// Connect a socket.io client; resolves on connect, rejects on connect_error.
const connect = (token) =>
  new Promise((resolve, reject) => {
    const c = ioClient(url, {
      auth: token != null ? { token } : {},
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    clients.push(c);
    c.once('connect', () => resolve(c));
    c.once('connect_error', (err) => reject(err));
  });

const waitFor = (client, event, ms = 1500) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for "${event}"`)), ms);
    client.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload ?? null);
    });
  });

before(async () => {
  users = await seedUsers();
  await cleanup();
  httpServer = createServer(app);
  initializeSocket(httpServer);
  await new Promise((res) => httpServer.listen(0, res));
  url = `http://127.0.0.1:${httpServer.address().port}`;
});

beforeEach(cleanup);

afterEach(() => {
  for (const c of clients) c.disconnect();
  clients = [];
});

after(async () => {
  await cleanup();
  await new Promise((res) => httpServer.close(res));
  await prisma.$disconnect();
});

// ── Handshake auth ────────────────────────────────────────────────────────────
test('connects with a valid token', async () => {
  const c = await connect(tokenFor('SALES_USER'));
  assert.equal(c.connected, true);
});

test('rejects a connection with no token', async () => {
  await assert.rejects(connect(null));
});

test('rejects a connection with an invalid token', async () => {
  await assert.rejects(connect('not.a.real.jwt'));
});

test('rejects a connection for a deactivated user', async () => {
  const u = await prisma.user.upsert({
    where: { email: 'sock-deactivated@test.local' },
    update: { isActive: false },
    create: { name: 'Off', email: 'sock-deactivated@test.local', password: 'x', role: 'SALES_USER', isActive: false },
  });
  const token = jwt.sign({ userId: u.id, role: 'SALES_USER' }, process.env.JWT_SECRET);
  await assert.rejects(connect(token));
});

// ── Targeted emit ─────────────────────────────────────────────────────────────
test('notifyUser delivers only to that user, not others', async () => {
  const sales = await connect(tokenFor('SALES_USER'));
  const feas = await connect(tokenFor('FEASIBILITY_USER'));

  let feasGotIt = false;
  feas.once('notification', () => {
    feasGotIt = true;
  });
  const onSales = waitFor(sales, 'notification');

  notifyUser(users.SALES_USER.id, 'notification', { title: 'for sales only' });

  const payload = await onSales;
  assert.equal(payload.title, 'for sales only');
  await new Promise((r) => setTimeout(r, 200)); // give any stray emit time to (not) arrive
  assert.equal(feasGotIt, false, 'feasibility user must not receive a sales-targeted event');
});

test('the same user on two devices receives the event on both', async () => {
  const a = await connect(tokenFor('NOC_L2_USER'));
  const b = await connect(tokenFor('NOC_L2_USER'));
  const onA = waitFor(a, 'notification');
  const onB = waitFor(b, 'notification');
  notifyUser(users.NOC_L2_USER.id, 'notification', { title: 'multi-device' });
  const [pa, pb] = await Promise.all([onA, onB]);
  assert.equal(pa.title, 'multi-device');
  assert.equal(pb.title, 'multi-device');
});

// ── Broadcast (the sidebar-count fix) ────────────────────────────────────────
test('broadcastSidebarRefresh reaches every connected client', async () => {
  const sales = await connect(tokenFor('SALES_USER'));
  const store = await connect(tokenFor('STORE_USER'));
  const onSales = waitFor(sales, 'sidebar:refresh');
  const onStore = waitFor(store, 'sidebar:refresh');
  broadcastSidebarRefresh();
  await Promise.all([onSales, onStore]); // both resolve → both refreshed
});

test('a transition pushes a notification to the receiving role and refreshes everyone', async () => {
  const feas = await connect(tokenFor('FEASIBILITY_USER'));
  const store = await connect(tokenFor('STORE_USER')); // uninvolved role
  const lead = await createLead(); // NEW

  const feasNotif = waitFor(feas, 'notification');
  const storeRefresh = waitFor(store, 'sidebar:refresh');

  await sm.submitForFeasibility({
    leadId: lead.id,
    actor: { id: users.SALES_USER.id, role: 'SALES_USER', label: 'sales' },
  });

  const n = await feasNotif;
  assert.match(n.title, /feasibility/i);
  await storeRefresh; // even the uninvolved store user gets the global refresh
});

test('REGRESSION: approval refreshes ALL sales sidebars, not just the lead owner', async () => {
  // A second sales user who does NOT own the lead.
  const sales2 = await prisma.user.upsert({
    where: { email: 'sales2@test.local' },
    update: { isActive: true },
    create: { name: 'Sales Two', email: 'sales2@test.local', password: 'x', role: 'SALES_USER' },
  });

  const owner = await connect(tokenFor('SALES_USER')); // owns the lead
  const otherSales = await connect(
    jwt.sign({ userId: sales2.id, role: 'SALES_USER' }, process.env.JWT_SECRET),
  );

  const lead = await createLead({
    status: 'PENDING_APPROVAL',
    createdById: users.SALES_USER.id,
    assignedSalesId: users.SALES_USER.id,
  });

  const ownerNotif = waitFor(owner, 'notification'); // owner is the notify target
  const otherRefresh = waitFor(otherSales, 'sidebar:refresh'); // the bug: this used to never arrive

  await sm.approveLead({ leadId: lead.id, actor: { id: users.ADMIN.id, label: 'admin' } });

  await ownerNotif; // owner still gets the approval notification
  await otherRefresh; // and the non-owner sales user's badge now refreshes too
});
