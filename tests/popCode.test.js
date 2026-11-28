import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { backfillPopCodes, generateLocationCode, renumberLocationCodesOnce } from '../src/services/popCode.service.js';
import { prisma, seedUsers, cleanup } from './helpers.mjs';

const resetCounters = () => prisma.counter.deleteMany({ where: { key: { in: ['POP', 'JN', 'POP_ID_SCHEME'] } } });

before(async () => {
  await seedUsers();
  await cleanup();
});
beforeEach(async () => {
  await cleanup();
  await resetCounters();
});
after(async () => {
  await cleanup();
  await resetCounters();
  await prisma.$disconnect();
});

test('POPs and junctions have separate series that grow past 999', async () => {
  assert.equal(await generateLocationCode(prisma, { popType: '10G' }), 'POP-001');
  assert.equal(await generateLocationCode(prisma, { junctionType: 'JC 48F' }), 'JN-001');
  assert.equal(await generateLocationCode(prisma, {}), 'POP-002', 'untyped legacy rows count as POPs');
  await prisma.counter.update({ where: { key: 'JN' }, data: { value: 999 } });
  assert.equal(await generateLocationCode(prisma, { junctionType: 'JC 96F' }), 'JN-1000');
});

test('the one-time renumber is gap-free per series, oldest first, and runs once', async () => {
  const day = (d) => new Date(`2026-01-0${d}T00:00:00Z`);
  await prisma.popLocation.createMany({
    data: [
      { name: 'P-old', latitude: 1, longitude: 1, popType: '10G', createdAt: day(1), popCode: 'POP-001' },
      { name: 'J-old', latitude: 1, longitude: 1, junctionType: 'JC 48F', createdAt: day(2), popCode: 'POP-002' },
      { name: 'P-new', latitude: 1, longitude: 1, popType: '1G', createdAt: day(3), popCode: 'POP-003' },
      { name: 'J-new', latitude: 1, longitude: 1, junctionType: '4w FTA', createdAt: day(4), popCode: null },
      { name: 'Legacy', latitude: 1, longitude: 1, createdAt: day(5), popCode: 'POP-004' },
    ],
  });
  assert.equal(await renumberLocationCodesOnce(), 5);
  const codes = async () => Object.fromEntries((await prisma.popLocation.findMany()).map((p) => [p.name, p.popCode]));
  assert.deepEqual(await codes(), { 'P-old': 'POP-001', 'J-old': 'JN-001', 'P-new': 'POP-002', 'J-new': 'JN-002', Legacy: 'POP-003' });

  // Counters continue from the renumbered totals…
  assert.equal(await generateLocationCode(prisma, { popType: '10G' }), 'POP-004');
  assert.equal(await generateLocationCode(prisma, { junctionType: 'JC 48F' }), 'JN-003');
  // …and the renumber never runs again, even if IDs are later disturbed.
  await prisma.popLocation.update({ where: { name: 'P-old' }, data: { popCode: 'POP-999' } });
  assert.equal(await renumberLocationCodesOnce(), 0);
  assert.equal((await prisma.popLocation.findUnique({ where: { name: 'P-old' } })).popCode, 'POP-999');
});

test('the boot safety net fixes missing or wrong-series IDs only', async () => {
  await prisma.counter.create({ data: { key: 'JN', value: 5 } });
  await prisma.popLocation.createMany({
    data: [
      { name: 'Fine', latitude: 1, longitude: 1, popType: '10G', popCode: 'POP-001' },
      { name: 'Junction with POP id', latitude: 1, longitude: 1, junctionType: 'JC 48F', popCode: 'POP-002' },
      { name: 'No id', latitude: 1, longitude: 1, popType: '1G', popCode: null },
    ],
  });
  assert.equal(await backfillPopCodes(), 2);
  const byName = Object.fromEntries((await prisma.popLocation.findMany()).map((p) => [p.name, p.popCode]));
  assert.equal(byName.Fine, 'POP-001');
  assert.equal(byName['Junction with POP id'], 'JN-006');
  assert.match(byName['No id'], /^POP-\d{3}$/);
  assert.equal(await backfillPopCodes(), 0);
});
