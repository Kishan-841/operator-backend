/**
 * One-time backfill for multi-access-users: give every staff user an accesses
 * set equal to [their current role]; leave admins with []. Idempotent — skips
 * users that already have a non-empty accesses set. Run once per environment:
 *   node --env-file=.env scripts/backfillAccesses.mjs
 */
import prisma from '../src/config/db.js';

const ADMIN_ROLES = ['SUPER_ADMIN', 'ADMIN'];

const run = async () => {
  const users = await prisma.user.findMany({ select: { id: true, role: true, accesses: true } });
  let updated = 0;
  for (const u of users) {
    if (u.accesses.length) continue; // already backfilled
    const accesses = ADMIN_ROLES.includes(u.role) ? [] : [u.role];
    if (!accesses.length) continue; // admins keep [], nothing to write
    await prisma.user.update({ where: { id: u.id }, data: { accesses } });
    updated += 1;
  }
  console.log(`Backfilled accesses for ${updated} staff user(s); ${users.length} scanned.`);
};

run()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
