import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { seedPincodes } from './pincodeData.js';

const prisma = new PrismaClient();

// Shared dev password for every seeded account.
const PASSWORD = process.env.SEED_PASSWORD || '123456';

// One user per role. Emails follow <role>@email.com.
const USERS = [
  { role: 'SUPER_ADMIN', name: 'Super Admin', email: 'superadmin@email.com' },
  { role: 'ADMIN', name: 'Admin', email: 'admin@email.com' },
  { role: 'SALES_USER', name: 'Sales', email: 'sales@email.com' },
  { role: 'FEASIBILITY_USER', name: 'Feasibility', email: 'feasibility@email.com' },
  { role: 'DELIVERY_USER', name: 'Delivery', email: 'delivery@email.com' },
  { role: 'STORE_USER', name: 'Store', email: 'store@email.com' },
  { role: 'NOC_L2_USER', name: 'NOC L2', email: 'nocl2@email.com' },
  { role: 'NOC_L3_USER', name: 'NOC L3', email: 'nocl3@email.com' },
  { role: 'SOFTWARE_USER', name: 'Software', email: 'software@email.com' },
];

async function main() {
  const password = await bcrypt.hash(PASSWORD, 10);

  for (const u of USERS) {
    const email = u.email.toLowerCase();
    // Match by the new email first; otherwise reuse the existing seeded user of
    // this role (migrates older emails in place — preserves IDs and lead FKs).
    let user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      user = await prisma.user.findFirst({ where: { role: u.role }, orderBy: { createdAt: 'asc' } });
    }

    if (user) {
      await prisma.user.update({
        where: { id: user.id },
        data: { email, name: u.name, role: u.role, password, isActive: true },
      });
    } else {
      await prisma.user.create({
        data: { email, name: u.name, role: u.role, password, isActive: true },
      });
    }
  }

  // Default lead-document types (users can add more from the docs modal).
  const DOC_TYPES = [
    'Aadhaar Card',
    'PAN',
    'ISP Licence',
    'Shop Act Licence',
    'Udhyam Aadhaar',
    'SLA',
    'Operator Agreement',
  ];
  for (const name of DOC_TYPES) {
    await prisma.documentType.upsert({ where: { name }, update: {}, create: { name } });
  }

  // All-India pincode master for the Territory picker (idempotent — skips if
  // already loaded). Sourced from the bundled prisma/data/pincodes.csv.gz.
  await seedPincodes(prisma, { log: console.log });

  const total = await prisma.user.count();
  console.log(`Seed complete. ${total} users. Password for all: ${PASSWORD}`);
  console.log(`  Document types: ${DOC_TYPES.length}`);
  for (const u of USERS) console.log(`  ${u.role.padEnd(18)} ${u.email}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
