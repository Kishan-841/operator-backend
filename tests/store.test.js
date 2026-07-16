import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import app from '../src/app.js';
import { prisma, seedUsers, cleanup, createProduct, createStock, TEST_PASSWORD } from './helpers.mjs';

// ── HTTP harness (same shape as controllers.test.js) ─────────────────────────
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
    /* non-JSON / empty */
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
  tokens.admin = await login('ADMIN');
  tokens.store = await login('STORE_USER');
  tokens.delivery = await login('DELIVERY_USER');
  tokens.sales = await login('SALES_USER');
});

beforeEach(cleanup);

after(async () => {
  await cleanup();
  await new Promise((res) => server.close(res));
  await prisma.$disconnect();
});

const validProduct = () => ({
  category: 'SWITCH',
  modelNumber: 'C9200-24',
  brandName: 'Cisco',
  price: 45000,
  unit: 'pcs',
});

// ── Phase B: product catalogue ───────────────────────────────────────────────
test('POST /api/store/products (store, valid) → 201 with the product', async () => {
  const r = await request('POST', '/api/store/products', { token: tokens.store, body: validProduct() });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.modelNumber, 'C9200-24');
  assert.equal(r.body.data.category, 'SWITCH');
  assert.equal(r.body.data.isActive, true);
});

test('POST /api/store/products with an invalid category → 400', async () => {
  const r = await request('POST', '/api/store/products', {
    token: tokens.store,
    body: { ...validProduct(), category: 'LASER' },
  });
  assert.equal(r.status, 400);
});

test('POST /api/store/products rejects a duplicate modelNumber → 409', async () => {
  await createProduct({ modelNumber: 'DUP-1' });
  const r = await request('POST', '/api/store/products', {
    token: tokens.store,
    body: { ...validProduct(), modelNumber: 'DUP-1' },
  });
  assert.equal(r.status, 409);
});

test('POST /api/store/products forbidden for a non-store role → 403', async () => {
  const r = await request('POST', '/api/store/products', { token: tokens.sales, body: validProduct() });
  assert.equal(r.status, 403);
});

test('GET /api/store/products returns a paginated envelope, searchable by model/brand', async () => {
  await createProduct({ modelNumber: 'AAA-1', brandName: 'Juniper' });
  await createProduct({ modelNumber: 'BBB-2', brandName: 'Cisco' });

  const all = await request('GET', '/api/store/products', { token: tokens.store });
  assert.equal(all.status, 200);
  assert.equal(all.body.pagination.total, 2);

  const hit = await request('GET', '/api/store/products?search=Juniper', { token: tokens.store });
  assert.equal(hit.body.items.length, 1);
  assert.equal(hit.body.items[0].modelNumber, 'AAA-1');
});

test('GET /api/store/products filters by category', async () => {
  await createProduct({ modelNumber: 'SW-1', category: 'SWITCH' });
  await createProduct({ modelNumber: 'FB-1', category: 'FIBER', unit: 'mtrs' });
  const r = await request('GET', '/api/store/products?category=FIBER', { token: tokens.store });
  assert.equal(r.body.items.length, 1);
  assert.equal(r.body.items[0].category, 'FIBER');
});

test('GET /api/store/products/options lists active products for the picker (delivery can read)', async () => {
  await createProduct({ modelNumber: 'ACTIVE-1' });
  await createProduct({ modelNumber: 'GONE-1', isActive: false });
  const r = await request('GET', '/api/store/products/options', { token: tokens.delivery });
  assert.equal(r.status, 200);
  const models = r.body.items.map((p) => p.modelNumber);
  assert.ok(models.includes('ACTIVE-1'));
  assert.ok(!models.includes('GONE-1'), 'inactive products are hidden from the picker');
});

test('PUT /api/store/products/:id updates fields', async () => {
  const p = await createProduct({ modelNumber: 'EDIT-1', price: 100 });
  const r = await request('PUT', `/api/store/products/${p.id}`, {
    token: tokens.store,
    body: { ...validProduct(), modelNumber: 'EDIT-1', price: 250, isActive: false },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.price, 250);
  assert.equal(r.body.data.isActive, false);
});

test('DELETE /api/store/products/:id removes an unused product', async () => {
  const p = await createProduct({ modelNumber: 'DEL-1' });
  const r = await request('DELETE', `/api/store/products/${p.id}`, { token: tokens.store });
  assert.equal(r.status, 200);
  assert.equal(await prisma.storeProduct.count({ where: { id: p.id } }), 0);
});

// ── Phase C: procurement (purchase orders) ───────────────────────────────────
// Create a PENDING_ADMIN PO with one item for `product`; returns the API body.
const makePO = async (product, { quantity = 2, token = tokens.store } = {}) =>
  request('POST', '/api/store/purchase-orders', {
    token,
    body: { notes: 'restock', items: [{ productId: product.id, quantity, unitPrice: 1000 }] },
  });

test('POST /api/store/purchase-orders (store) → 201, PO-#### number, PENDING_ADMIN, items PURCHASED', async () => {
  const p = await createProduct();
  const r = await makePO(p, { quantity: 3 });
  assert.equal(r.status, 201);
  assert.match(r.body.data.poNumber, /^PO-\d{4}$/);
  assert.equal(r.body.data.status, 'PENDING_ADMIN');
  assert.equal(r.body.data.items.length, 1);
  assert.equal(r.body.data.items[0].status, 'PURCHASED');
  assert.equal(r.body.data.items[0].quantity, 3);
});

test('POST /api/store/purchase-orders with no items → 400', async () => {
  const r = await request('POST', '/api/store/purchase-orders', { token: tokens.store, body: { items: [] } });
  assert.equal(r.status, 400);
});

test('POST /api/store/purchase-orders forbidden for a non-store role → 403', async () => {
  const p = await createProduct();
  const r = await makePO(p, { token: tokens.delivery });
  assert.equal(r.status, 403);
});

test('PO approval: admin approves PENDING_ADMIN → APPROVED', async () => {
  const p = await createProduct();
  const po = (await makePO(p)).body.data;
  const r = await request('POST', `/api/store/po-approval/${po.id}/approve`, { token: tokens.admin });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.status, 'APPROVED');
  assert.ok(r.body.data.adminApprovedAt);
});

test('PO approval is forbidden for the store role → 403', async () => {
  const p = await createProduct();
  const po = (await makePO(p)).body.data;
  const r = await request('POST', `/api/store/po-approval/${po.id}/approve`, { token: tokens.store });
  assert.equal(r.status, 403);
});

test('PO approval on an already-approved PO → 409', async () => {
  const p = await createProduct();
  const po = (await makePO(p)).body.data;
  await request('POST', `/api/store/po-approval/${po.id}/approve`, { token: tokens.admin });
  const again = await request('POST', `/api/store/po-approval/${po.id}/approve`, { token: tokens.admin });
  assert.equal(again.status, 409);
});

test('PO rejection needs a reason and moves to REJECTED', async () => {
  const p = await createProduct();
  const po = (await makePO(p)).body.data;
  const noReason = await request('POST', `/api/store/po-approval/${po.id}/reject`, { token: tokens.admin, body: {} });
  assert.equal(noReason.status, 400);
  const ok = await request('POST', `/api/store/po-approval/${po.id}/reject`, {
    token: tokens.admin,
    body: { reason: 'wrong vendor' },
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.status, 'REJECTED');
  assert.equal(ok.body.data.rejectedReason, 'wrong vendor');
});

test('add-to-inventory: serials on an APPROVED PO → items IN_STORE, PO COMPLETED, stock live', async () => {
  const p = await createProduct(); // serialized (pcs)
  const po = (await makePO(p, { quantity: 2 })).body.data;
  await request('POST', `/api/store/po-approval/${po.id}/approve`, { token: tokens.admin });

  const r = await request('POST', `/api/store/purchase-orders/${po.id}/add-to-inventory`, {
    token: tokens.store,
    body: { items: [{ poItemId: po.items[0].id, serialNumbers: ['SN-1', 'SN-2'] }] },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.status, 'COMPLETED');
  assert.equal(r.body.data.items[0].status, 'IN_STORE');
  assert.deepEqual(r.body.data.items[0].serialNumbers.sort(), ['SN-1', 'SN-2']);

  // Surfaces as available inventory for the product.
  const avail = await request('GET', `/api/store/available-inventory?productId=${p.id}`, { token: tokens.store });
  assert.equal(avail.body.items.length, 1);
  assert.equal(avail.body.items[0].serialNumbers.length, 2);
});

test('add-to-inventory on a not-yet-approved PO → 409', async () => {
  const p = await createProduct();
  const po = (await makePO(p)).body.data;
  const r = await request('POST', `/api/store/purchase-orders/${po.id}/add-to-inventory`, {
    token: tokens.store,
    body: { items: [{ poItemId: po.items[0].id, serialNumbers: ['X-1', 'X-2'] }] },
  });
  assert.equal(r.status, 409);
});

test('add-to-inventory: serialized item without serials → 400', async () => {
  const p = await createProduct(); // pcs
  const po = (await makePO(p)).body.data;
  await request('POST', `/api/store/po-approval/${po.id}/approve`, { token: tokens.admin });
  const r = await request('POST', `/api/store/purchase-orders/${po.id}/add-to-inventory`, {
    token: tokens.store,
    body: { items: [{ poItemId: po.items[0].id, serialNumbers: [] }] },
  });
  assert.equal(r.status, 400);
});

test('add-to-inventory: bulk item stocked by receivedQuantity → IN_STORE', async () => {
  const p = await createProduct({ modelNumber: 'FIBER-BULK', category: 'FIBER', unit: 'mtrs' });
  const po = (await makePO(p, { quantity: 500 })).body.data;
  await request('POST', `/api/store/po-approval/${po.id}/approve`, { token: tokens.admin });
  const r = await request('POST', `/api/store/purchase-orders/${po.id}/add-to-inventory`, {
    token: tokens.store,
    body: { items: [{ poItemId: po.items[0].id, receivedQuantity: 500 }] },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.items[0].status, 'IN_STORE');
  assert.equal(r.body.data.items[0].receivedQuantity, 500);
});

// ── Partial receiving — a PO must stay open until every ordered unit arrives ──
test('partial serials: PO stays APPROVED, item is assignable, progress tracked', async () => {
  const p = await createProduct();
  const po = (await makePO(p, { quantity: 10 })).body.data;
  await request('POST', `/api/store/po-approval/${po.id}/approve`, { token: tokens.admin });

  const r = await request('POST', `/api/store/purchase-orders/${po.id}/add-to-inventory`, {
    token: tokens.store,
    body: { items: [{ poItemId: po.items[0].id, serialNumbers: ['SN-1', 'SN-2', 'SN-3', 'SN-4'] }] },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.status, 'APPROVED', 'PO must NOT complete on a partial receipt');
  assert.equal(r.body.data.items[0].status, 'IN_STORE', 'partial stock is already assignable');
  assert.equal(r.body.data.items[0].stockedQuantity, 4);
  assert.equal(r.body.data.items[0].serialNumbers.length, 4);
});

test('second partial receipt appends serials and completes the PO when full', async () => {
  const p = await createProduct();
  const po = (await makePO(p, { quantity: 6 })).body.data;
  await request('POST', `/api/store/po-approval/${po.id}/approve`, { token: tokens.admin });
  const stock = (items) =>
    request('POST', `/api/store/purchase-orders/${po.id}/add-to-inventory`, { token: tokens.store, body: { items } });

  await stock([{ poItemId: po.items[0].id, serialNumbers: ['SN-1', 'SN-2', 'SN-3', 'SN-4'] }]);
  const r2 = await stock([{ poItemId: po.items[0].id, serialNumbers: ['SN-5', 'SN-6'] }]);
  assert.equal(r2.status, 200);
  assert.equal(r2.body.data.status, 'COMPLETED');
  assert.equal(r2.body.data.items[0].stockedQuantity, 6);
  assert.deepEqual(r2.body.data.items[0].serialNumbers.sort(), ['SN-1', 'SN-2', 'SN-3', 'SN-4', 'SN-5', 'SN-6']);
});

test('concurrent receipts of different serials on the same item both land (no lost update)', async () => {
  const p = await createProduct();
  const po = (await makePO(p, { quantity: 4 })).body.data;
  await request('POST', `/api/store/po-approval/${po.id}/approve`, { token: tokens.admin });
  const stock = (items) =>
    request('POST', `/api/store/purchase-orders/${po.id}/add-to-inventory`, { token: tokens.store, body: { items } });

  // Fire two receipts in parallel — the FOR UPDATE lock must serialize them so
  // neither overwrites the other's serials.
  const [a, b] = await Promise.all([
    stock([{ poItemId: po.items[0].id, serialNumbers: ['SN-A1', 'SN-A2'] }]),
    stock([{ poItemId: po.items[0].id, serialNumbers: ['SN-B1', 'SN-B2'] }]),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const item = await prisma.storePurchaseOrderItem.findFirst({ where: { poId: po.id } });
  assert.equal(item.stockedQuantity, 4, 'both receipts counted');
  assert.deepEqual(item.serialNumbers.sort(), ['SN-A1', 'SN-A2', 'SN-B1', 'SN-B2']);
});

test('a serial that repeats one already received on the item → 400', async () => {
  const p = await createProduct();
  const po = (await makePO(p, { quantity: 4 })).body.data;
  await request('POST', `/api/store/po-approval/${po.id}/approve`, { token: tokens.admin });
  const stock = (items) =>
    request('POST', `/api/store/purchase-orders/${po.id}/add-to-inventory`, { token: tokens.store, body: { items } });

  await stock([{ poItemId: po.items[0].id, serialNumbers: ['SN-1', 'SN-2'] }]);
  const r = await stock([{ poItemId: po.items[0].id, serialNumbers: ['SN-2', 'SN-3'] }]);
  assert.equal(r.status, 400);
});

test('receiving more serials than remain on order → 400', async () => {
  const p = await createProduct();
  const po = (await makePO(p, { quantity: 3 })).body.data;
  await request('POST', `/api/store/po-approval/${po.id}/approve`, { token: tokens.admin });
  const r = await request('POST', `/api/store/purchase-orders/${po.id}/add-to-inventory`, {
    token: tokens.store,
    body: { items: [{ poItemId: po.items[0].id, serialNumbers: ['SN-1', 'SN-2', 'SN-3', 'SN-4'] }] },
  });
  assert.equal(r.status, 400);
});

test('bulk partial receipt accumulates and completes at the ordered quantity', async () => {
  const p = await createProduct({ modelNumber: 'FIBER-PARTIAL', category: 'FIBER', unit: 'mtrs' });
  const po = (await makePO(p, { quantity: 100 })).body.data;
  await request('POST', `/api/store/po-approval/${po.id}/approve`, { token: tokens.admin });
  const stock = (q) =>
    request('POST', `/api/store/purchase-orders/${po.id}/add-to-inventory`, {
      token: tokens.store,
      body: { items: [{ poItemId: po.items[0].id, receivedQuantity: q }] },
    });

  const r1 = await stock(40);
  assert.equal(r1.status, 200);
  assert.equal(r1.body.data.status, 'APPROVED');
  assert.equal(r1.body.data.items[0].receivedQuantity, 40);

  const r2 = await stock(60);
  assert.equal(r2.status, 200);
  assert.equal(r2.body.data.status, 'COMPLETED');
  assert.equal(r2.body.data.items[0].receivedQuantity, 100);
  assert.equal(r2.body.data.items[0].stockedQuantity, 100);
});

test('a multi-item PO completes only when EVERY item is fully received', async () => {
  const p1 = await createProduct({ modelNumber: 'SW-A' });
  const p2 = await createProduct({ modelNumber: 'SW-B' });
  const po = (
    await request('POST', '/api/store/purchase-orders', {
      token: tokens.store,
      body: {
        notes: 'restock',
        items: [
          { productId: p1.id, quantity: 2 },
          { productId: p2.id, quantity: 2 },
        ],
      },
    })
  ).body.data;
  await request('POST', `/api/store/po-approval/${po.id}/approve`, { token: tokens.admin });

  // Fully receive item 1 only — the PO must stay open for item 2.
  const r = await request('POST', `/api/store/purchase-orders/${po.id}/add-to-inventory`, {
    token: tokens.store,
    body: { items: [{ poItemId: po.items[0].id, serialNumbers: ['A-1', 'A-2'] }] },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.status, 'APPROVED');
});

// ── Available material (whole-store inventory view) ──────────────────────────
test('GET /api/store/inventory lists per-product availability with serials', async () => {
  const sw = await createProduct({ modelNumber: 'SW-INV' });
  const fib = await createProduct({ modelNumber: 'FIB-INV', category: 'FIBER', unit: 'mtrs' });
  await createStock({ productId: sw.id, serialNumbers: ['S1', 'S2'] });
  await createStock({ productId: sw.id, serialNumbers: ['S3'] });
  await createStock({ productId: fib.id, serialNumbers: [], receivedQuantity: 250 });
  await createStock({ productId: sw.id, serialNumbers: [] }); // drained — excluded

  const r = await request('GET', '/api/store/inventory', { token: tokens.store });
  assert.equal(r.status, 200);
  const bySku = Object.fromEntries(r.body.items.map((i) => [i.product.modelNumber, i]));
  assert.equal(bySku['SW-INV'].available, 3);
  assert.deepEqual(bySku['SW-INV'].serialNumbers.sort(), ['S1', 'S2', 'S3']);
  assert.equal(bySku['FIB-INV'].available, 250);
});

test('GET /api/store/inventory is forbidden for a non-store role → 403', async () => {
  const r = await request('GET', '/api/store/inventory', { token: tokens.sales });
  assert.equal(r.status, 403);
});

test('GET /api/store/available-inventory hides non-IN_STORE and drained items', async () => {
  const p = await createProduct();
  await createStock({ productId: p.id, serialNumbers: ['A1', 'A2'] }); // IN_STORE
  await createStock({ productId: p.id, serialNumbers: [], status: 'PURCHASED' }); // not stocked
  await createStock({ productId: p.id, serialNumbers: [] }); // IN_STORE but drained (0 serials)
  const r = await request('GET', `/api/store/available-inventory?productId=${p.id}`, { token: tokens.store });
  assert.equal(r.status, 200);
  assert.equal(r.body.items.length, 1, 'only the stocked, non-empty item shows');
});
