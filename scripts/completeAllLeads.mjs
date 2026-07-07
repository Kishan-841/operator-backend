/**
 * Mark every in-pipeline lead as COMPLETED so all queue badges clear and the
 * pipeline reads as "all tasks done". Writes a COMPLETED audit entry per lead so
 * each counts as a conversion and appears in the event log.
 * Run: node scripts/completeAllLeads.mjs
 */
import prisma from '../src/config/db.js';

const run = async () => {
  const actor = await prisma.user.findFirst({
    where: { role: { in: ['SUPER_ADMIN', 'ADMIN'] } },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });

  const active = await prisma.lead.findMany({
    where: { status: { notIn: ['COMPLETED', 'REJECTED'] } },
    select: { id: true, leadNumber: true, status: true },
  });

  if (active.length === 0) {
    console.log('No in-pipeline leads — everything already COMPLETED.');
    return;
  }

  for (const lead of active) {
    await prisma.$transaction(async (tx) => {
      await tx.lead.update({ where: { id: lead.id }, data: { status: 'COMPLETED' } });
      await tx.statusChangeLog.create({
        data: {
          action: 'STATUS_CHANGED',
          entityType: 'Lead',
          entityId: lead.id,
          oldValue: lead.status,
          newValue: 'COMPLETED',
          summary: `${lead.leadNumber} marked COMPLETED`,
          changedById: actor?.id ?? null,
        },
      });
    });
  }
  console.log(`Completed ${active.length} lead(s):`, active.map((l) => `${l.leadNumber} (${l.status}→COMPLETED)`).join(', '));
};

run()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
