import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Bundled, version-controlled pincode master (gzipped CSV) — the reproducible
// source for seeding the Pincode table. Refresh it from a new sheet by passing
// the .xlsx path to importPincodes.mjs, which re-exports this file.
export const BUNDLED_PINCODES = path.join(HERE, 'data', 'pincodes.csv.gz');

const clean = (v) => (v == null ? '' : String(v).trim());
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const pick = (r, ...keys) => {
  for (const k of keys) {
    const v = r[k];
    if (v != null && v !== '') return v;
  }
  return null;
};

/**
 * Parse pincode records from either the bundled gzipped CSV (clean column
 * names) or the raw "All India Pincodes" .xlsx (circlename/officename/…). Rows
 * missing an essential field are skipped.
 */
export function loadPincodeRecords(file = BUNDLED_PINCODES) {
  if (!fs.existsSync(file)) throw new Error(`Pincode data file not found: ${file}`);

  let rows;
  if (file.endsWith('.xlsx')) {
    const wb = XLSX.readFile(file);
    rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null });
  } else {
    let buf = fs.readFileSync(file);
    if (file.endsWith('.gz')) buf = zlib.gunzipSync(buf);
    const wb = XLSX.read(buf.toString('utf8'), { type: 'string' });
    rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null });
  }

  const out = [];
  for (const r of rows) {
    const pincode = clean(pick(r, 'pincode'));
    const officeName = clean(pick(r, 'officeName', 'officename'));
    const district = clean(pick(r, 'district'));
    const state = clean(pick(r, 'state', 'statename'));
    if (!pincode || !officeName || !district || !state) continue;
    out.push({
      pincode,
      officeName,
      district,
      state,
      circle: clean(pick(r, 'circle', 'circlename')) || null,
      region: clean(pick(r, 'region', 'regionname')) || null,
      latitude: num(pick(r, 'latitude')),
      longitude: num(pick(r, 'longitude')),
    });
  }
  return out;
}

/**
 * Seed the Pincode table. Idempotent: skips when already populated unless
 * `force` is set (then it truncates + reloads). Inserts in chunks.
 */
export async function seedPincodes(prisma, { file = BUNDLED_PINCODES, force = false, log = () => {} } = {}) {
  const existing = await prisma.pincode.count();
  if (existing > 0 && !force) {
    log(`  Pincodes: ${existing} already present — skipping.`);
    return existing;
  }

  const records = loadPincodeRecords(file);
  log(`  Pincodes: loading ${records.length} from ${path.basename(file)}…`);
  // Atomic replace: delete + all inserts commit together, so an interruption
  // (crash, Ctrl+C, timeout) rolls back and leaves the existing data intact
  // rather than an empty table that silently breaks the Territory picker.
  const CHUNK = 5000;
  await prisma.$transaction(
    async (tx) => {
      await tx.pincode.deleteMany({});
      for (let i = 0; i < records.length; i += CHUNK) {
        await tx.pincode.createMany({ data: records.slice(i, i + CHUNK) });
      }
    },
    { timeout: 120000, maxWait: 15000 },
  );
  const total = await prisma.pincode.count();
  log(`  Pincodes: seeded ${total}.`);
  return total;
}
