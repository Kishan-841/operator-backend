import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { backfillPopCodes, generatePopCode } from '../src/services/popCode.service.js';
import { prisma, seedUsers, cleanup } from './helpers.mjs';

before(async () => {
  await seedUsers();
  await cleanup();
});
beforeEach(async () => {
  await cleanup();
  await prisma.counter.deleteMany({ where: { key: 'POP' } });
});
after(async () => {
  await cleanup();
  await prisma.counter.deleteMany({ where: { key: 'POP' } });
  await prisma.$disconnect();
});

test('POP IDs are POP-001, POP-002, … and keep growing past 999', async () => {
  assert.equal(await generatePopCode(), 'POP-001');
  assert.equal(await generatePopCode(), 'POP-002');
  await prisma.counter.update({ where: { key: 'POP' }, data: { value: 999 } });
  assert.equal(await generatePopCode(), 'POP-1000');
});

test('backfill numbers existing POPs oldest first, once', async () => {
  const day = (d) => new Date(`2026-01-0${d}T00:00:00Z`);
  await prisma.popLocation.createMany({
    data: [
      { name: 'Newest', latitude: 1, longitude: 1, createdAt: day(3) },
      { name: 'Oldest', latitude: 1, longitude: 1, createdAt: day(1) },
      { name: 'Middle', latitude: 1, longitude: 1, createdAt: day(2) },
      { name: 'Has ID', latitude: 1, longitude: 1, createdAt: day(1), popCode: 'POP-777' },
    ],
  });
  assert.equal(await backfillPopCodes(), 3);
  const byName = Object.fromEntries((await prisma.popLocation.findMany()).map((p) => [p.name, p.popCode]));
  assert.deepEqual(byName, { Oldest: 'POP-001', Middle: 'POP-002', Newest: 'POP-003', 'Has ID': 'POP-777' });
  assert.equal(await backfillPopCodes(), 0, 'a second run changes nothing');
});
