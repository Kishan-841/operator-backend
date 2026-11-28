import prisma from '../config/db.js';
import { generateNumber, reserveNumbers } from './leadNumber.service.js';

// POP IDs: POP-001, POP-002, … (grows past 999 naturally: POP-1000).
const KEY = 'POP';
const PREFIX = 'POP';
const PAD = 3;

/** Next POP ID. Pass the transaction the POP is created in. */
export const generatePopCode = (tx = prisma) => generateNumber(tx, KEY, PREFIX, PAD);

/** `count` consecutive POP IDs for a bulk import. */
export const reservePopCodes = (tx, count) => reserveNumbers(tx, KEY, PREFIX, count, PAD);

/**
 * Give every POP that has no ID yet the next one, oldest first. Run at boot so
 * POPs created before IDs existed get numbered once. Idempotent: rows that
 * already have an ID are untouched, and the conditional update means two
 * instances running at once can never number the same POP twice.
 */
export const backfillPopCodes = async () => {
  const pending = await prisma.popLocation.findMany({
    where: { popCode: null },
    orderBy: [{ createdAt: 'asc' }, { name: 'asc' }],
    select: { id: true },
  });
  let assigned = 0;
  for (const { id } of pending) {
    const done = await prisma.$transaction(async (tx) => {
      const code = await generatePopCode(tx);
      const r = await tx.popLocation.updateMany({ where: { id, popCode: null }, data: { popCode: code } });
      if (r.count === 0) throw Object.assign(new Error('already numbered'), { skip: true }); // roll the counter back
      return true;
    }).catch((e) => {
      if (e?.skip) return false;
      throw e;
    });
    if (done) assigned += 1;
  }
  return assigned;
};
