import prisma from '../config/db.js';
import { generateNumber, reserveNumbers } from './leadNumber.service.js';

// Location IDs have two series: POPs are POP-001, POP-002, …; junctions are
// JN-001, JN-002, … (each grows past 999 naturally). A location is a junction
// when it carries a junctionType; anything else (incl. untyped legacy rows) is a POP.
const SERIES = {
  POP: { key: 'POP', prefix: 'POP' },
  JN: { key: 'JN', prefix: 'JN' },
};
const PAD = 3;

export const seriesFor = (loc) => (loc?.junctionType ? 'JN' : 'POP');

const format = (series, n) => `${SERIES[series].prefix}-${String(n).padStart(PAD, '0')}`;

/** Does `code` belong to `series` (POP-… for POPs, JN-… for junctions)? */
export const codeMatchesSeries = (code, series) =>
  typeof code === 'string' && code.startsWith(`${SERIES[series].prefix}-`);

/** Next ID for a location. Pass the transaction it's created/updated in. */
export const generateLocationCode = (tx, loc) => {
  const { key, prefix } = SERIES[seriesFor(loc)];
  return generateNumber(tx, key, prefix, PAD);
};

/** IDs for a bulk import, in row order — one counter bump per series. */
export const codesForRows = async (tx, rows) => {
  const want = { POP: 0, JN: 0 };
  for (const r of rows) want[seriesFor(r)] += 1;
  const pools = {
    POP: await reserveNumbers(tx, SERIES.POP.key, SERIES.POP.prefix, want.POP, PAD),
    JN: await reserveNumbers(tx, SERIES.JN.key, SERIES.JN.prefix, want.JN, PAD),
  };
  return rows.map((r) => pools[seriesFor(r)].shift());
};

// One-time switch to the two-series scheme: renumber every location gap-free
// (oldest first, per series) and reset both counters. A Counter row records
// that it ran, so it happens exactly once per database.
const SCHEME_KEY = 'POP_ID_SCHEME';
const SCHEME_VERSION = 2;
const LOCK_ID = 7340101; // pg advisory lock — serialises concurrent boots

export const renumberLocationCodesOnce = () =>
  prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_ID})`;
      const marker = await tx.counter.findUnique({ where: { key: SCHEME_KEY } });
      if ((marker?.value ?? 0) >= SCHEME_VERSION) return 0;

      const all = await tx.popLocation.findMany({
        orderBy: [{ createdAt: 'asc' }, { name: 'asc' }],
        select: { id: true, junctionType: true },
      });
      const n = { POP: 0, JN: 0 };
      for (const loc of all) {
        const series = seriesFor(loc);
        n[series] += 1;
        await tx.popLocation.update({ where: { id: loc.id }, data: { popCode: format(series, n[series]) } });
      }
      for (const series of Object.keys(SERIES)) {
        const { key } = SERIES[series];
        await tx.counter.upsert({ where: { key }, update: { value: n[series] }, create: { key, value: n[series] } });
      }
      await tx.counter.upsert({
        where: { key: SCHEME_KEY },
        update: { value: SCHEME_VERSION },
        create: { key: SCHEME_KEY, value: SCHEME_VERSION },
      });
      return all.length;
    },
    { timeout: 60000 },
  );

/**
 * Safety net run at every boot: give the next ID of the right series to any
 * location with no ID or one from the wrong series. Idempotent, and the
 * conditional update means two instances can never number the same row twice.
 */
export const backfillPopCodes = async () => {
  const rows = await prisma.popLocation.findMany({
    orderBy: [{ createdAt: 'asc' }, { name: 'asc' }],
    select: { id: true, popCode: true, junctionType: true },
  });
  let assigned = 0;
  for (const loc of rows) {
    if (codeMatchesSeries(loc.popCode, seriesFor(loc))) continue;
    const done = await prisma
      .$transaction(async (tx) => {
        const code = await generateLocationCode(tx, loc);
        const r = await tx.popLocation.updateMany({ where: { id: loc.id, popCode: loc.popCode }, data: { popCode: code } });
        if (r.count === 0) throw Object.assign(new Error('changed meanwhile'), { skip: true }); // roll the counter back
        return true;
      })
      .catch((e) => {
        if (e?.skip) return false;
        throw e;
      });
    if (done) assigned += 1;
  }
  return assigned;
};

/** Boot-time: one-time renumber (if not done yet), then the safety net. */
export const ensureLocationCodes = async () => {
  const renumbered = await renumberLocationCodesOnce();
  const fixed = await backfillPopCodes();
  return { renumbered, fixed };
};

/**
 * Validate an ID an admin typed for `loc`: the right series prefix (POP- for a
 * POP, JN- for a junction) and at least 3 digits. Spaces are dropped and it's
 * upper-cased ("jn - 7" won't pass, "jn-007" → "JN-007"). Returns
 * { code } or { error }.
 */
export const parseManualCode = (raw, loc) => {
  const series = seriesFor(loc);
  const { prefix } = SERIES[series];
  const code = String(raw ?? '').replace(/\s+/g, '').toUpperCase();
  if (!new RegExp(`^${prefix}-\\d{3,}$`).test(code)) {
    return { error: `The ID must look like ${prefix}-001 for ${series === 'JN' ? 'a junction' : 'a POP'}.` };
  }
  return { code };
};

/**
 * Record a hand-picked ID against its series counter: if it's ahead of the
 * counter, move the counter up so the app never generates that number later.
 */
export const claimManualCode = async (tx, code, loc) => {
  const { key } = SERIES[seriesFor(loc)];
  const n = Number(code.split('-')[1]);
  const counter = await tx.counter.findUnique({ where: { key } });
  if (!counter) await tx.counter.create({ data: { key, value: n } });
  else if (counter.value < n) await tx.counter.update({ where: { key }, data: { value: n } });
};
