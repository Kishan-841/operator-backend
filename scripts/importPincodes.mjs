/**
 * Reload the Pincode master table.
 *
 * Usage:
 *   node scripts/importPincodes.mjs                       # from the bundled prisma/data/pincodes.csv.gz
 *   node scripts/importPincodes.mjs "/path/to/sheet.xlsx" # refresh from a new "All India Pincodes" sheet
 *
 * Always truncates + reloads (force). When refreshing from a new .xlsx, also
 * re-export the bundled CSV so the change is version-controlled:
 *   node scripts/exportPincodes.mjs
 */
import { PrismaClient } from '@prisma/client';
import { seedPincodes, BUNDLED_PINCODES } from '../prisma/pincodeData.js';

const prisma = new PrismaClient();
const file = process.argv[2] || BUNDLED_PINCODES;

seedPincodes(prisma, { file, force: true, log: (m) => console.log(m.trim()) })
  .then((total) => console.log(`Done. Pincode table now holds ${total} rows.`))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
