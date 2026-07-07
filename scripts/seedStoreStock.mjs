/**
 * Seed live inventory (APPROVED POs with IN_STORE items) for a few catalogue
 * products so the store-dispatch / assignment flow is demoable without manually
 * running the full PO → approve → add-to-inventory loop.
 * Idempotent-ish: skips a product that already has IN_STORE stock.
 * Run: node scripts/seedStoreProducts.mjs && node scripts/seedStoreStock.mjs
 */
import prisma from '../src/config/db.js';
import { generatePurchaseOrderNumber } from '../src/services/leadNumber.service.js';

// modelNumber → how to stock it. Serialized products get serials; bulk get qty.
const STOCK = [
  { modelNumber: 'C9200-24T', serials: ['C9200-A1', 'C9200-A2', 'C9200-A3'] },
  { modelNumber: 'RB5009UG', serials: ['RB5009-1', 'RB5009-2'] },
  { modelNumber: 'GLC-LH-SMD', serials: ['SFP-1', 'SFP-2', 'SFP-3', 'SFP-4'] },
  { modelNumber: 'SM-G652D-2F', receivedQuantity: 2000 }, // bulk fiber (mtrs)
];

const run = async () => {
  const store = await prisma.user.findFirst({
    where: { role: { in: ['STORE_USER', 'ADMIN', 'SUPER_ADMIN'] } },
    orderBy: { createdAt: 'asc' },
  });
  if (!store) throw new Error('No STORE_USER/ADMIN found — run `node prisma/seed.js` first.');

  let stocked = 0;
  for (const s of STOCK) {
    const product = await prisma.storeProduct.findUnique({ where: { modelNumber: s.modelNumber } });
    if (!product) {
      console.log(`  skip   ${s.modelNumber.padEnd(16)} (not in catalog — run seedStoreProducts first)`);
      continue;
    }
    const existing = await prisma.storePurchaseOrderItem.count({
      where: { productId: product.id, status: 'IN_STORE' },
    });
    if (existing > 0) {
      console.log(`  skip   ${s.modelNumber.padEnd(16)} (already stocked)`);
      continue;
    }
    const serials = s.serials ?? [];
    const receivedQuantity = s.receivedQuantity ?? serials.length;
    await prisma.$transaction(async (tx) => {
      const poNumber = await generatePurchaseOrderNumber(tx);
      await tx.storePurchaseOrder.create({
        data: {
          poNumber,
          status: 'COMPLETED',
          createdById: store.id,
          adminApprovedById: store.id,
          adminApprovedAt: new Date(),
          items: {
            create: [
              {
                productId: product.id,
                quantity: receivedQuantity,
                serialNumbers: serials,
                receivedQuantity,
                status: 'IN_STORE',
                addedToStoreAt: new Date(),
              },
            ],
          },
        },
      });
    });
    stocked += 1;
    console.log(`  stock  ${s.modelNumber.padEnd(16)} ${serials.length ? `${serials.length} serials` : `${receivedQuantity} m`}`);
  }
  console.log(`\nDone. ${stocked} product(s) stocked.`);
  await prisma.$disconnect();
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
