/**
 * Export the current Pincode table to the bundled, version-controlled
 * prisma/data/pincodes.csv.gz. Run this after reloading the table from a fresh
 * "All India Pincodes" sheet, then commit the regenerated file.
 *
 * Usage: node scripts/exportPincodes.mjs
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { PrismaClient } from '@prisma/client';
import { BUNDLED_PINCODES } from '../prisma/pincodeData.js';

const prisma = new PrismaClient();

const esc = (v) => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function main() {
  const total = await prisma.pincode.count();
  const out = fs.createWriteStream(BUNDLED_PINCODES);
  const gz = zlib.createGzip({ level: 9 });
  gz.pipe(out);
  gz.write('pincode,officeName,district,state,circle,region,latitude,longitude\n');

  const PAGE = 10000;
  for (let skip = 0; skip < total; skip += PAGE) {
    const rows = await prisma.pincode.findMany({
      skip,
      take: PAGE,
      orderBy: { id: 'asc' },
      select: {
        pincode: true,
        officeName: true,
        district: true,
        state: true,
        circle: true,
        region: true,
        latitude: true,
        longitude: true,
      },
    });
    for (const r of rows) {
      gz.write(
        [r.pincode, r.officeName, r.district, r.state, r.circle, r.region, r.latitude, r.longitude]
          .map(esc)
          .join(',') + '\n',
      );
    }
  }
  await new Promise((res, rej) => {
    out.on('finish', res);
    out.on('error', rej);
    gz.end();
  });
  console.log(`Exported ${total} rows → ${BUNDLED_PINCODES}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
