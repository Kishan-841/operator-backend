/**
 * Seed a starter product catalogue so the store flow is demoable.
 * Idempotent — upserts each product by its unique modelNumber.
 * Run: node scripts/seedStoreProducts.mjs
 */
import prisma from '../src/config/db.js';

const PRODUCTS = [
  { category: 'SWITCH', modelNumber: 'C9200-24T', brandName: 'Cisco', price: 145000, unit: 'pcs' },
  { category: 'SWITCH', modelNumber: 'MS120-8', brandName: 'Meraki', price: 62000, unit: 'pcs' },
  { category: 'ROUTER', modelNumber: 'RB5009UG', brandName: 'MikroTik', price: 22000, unit: 'pcs' },
  { category: 'SFP', modelNumber: 'GLC-LH-SMD', brandName: 'Cisco', price: 3500, unit: 'pcs' },
  { category: 'MEDIA_CONVERTER', modelNumber: 'MC220L', brandName: 'TP-Link', price: 1800, unit: 'pcs' },
  { category: 'CLOSURE', modelNumber: 'FOSC-24', brandName: 'Commscope', price: 2600, unit: 'pcs' },
  { category: 'FIBER', modelNumber: 'SM-G652D-2F', brandName: 'Sterlite', price: 14, unit: 'mtrs' },
  { category: 'PATCH_CORD', modelNumber: 'LC-LC-SM-3M', brandName: 'D-Link', price: 220, unit: 'pcs' },
];

const run = async () => {
  const store = await prisma.user.findFirst({
    where: { role: { in: ['STORE_USER', 'ADMIN', 'SUPER_ADMIN'] } },
    orderBy: { createdAt: 'asc' },
  });
  if (!store) throw new Error('No STORE_USER/ADMIN found — run `node prisma/seed.js` first.');

  let created = 0;
  let skipped = 0;
  for (const p of PRODUCTS) {
    const existing = await prisma.storeProduct.findUnique({ where: { modelNumber: p.modelNumber } });
    if (existing) {
      skipped += 1;
      console.log(`  skip   ${p.modelNumber.padEnd(16)} (exists)`);
      continue;
    }
    await prisma.storeProduct.create({ data: { ...p, createdById: store.id } });
    created += 1;
    console.log(`  create ${p.modelNumber.padEnd(16)} ${p.category}`);
  }
  console.log(`\nDone. ${created} created, ${skipped} skipped.`);
  await prisma.$disconnect();
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
