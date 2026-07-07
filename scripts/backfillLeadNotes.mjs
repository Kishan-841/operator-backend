/**
 * One-time backfill: surface the notes already sitting on existing leads
 * (scattered across feasibility/pricing/aggregator/NOC L2/pipelineNotes/etc.)
 * into the unified LeadNote timeline. Idempotent — re-running skips duplicates.
 * Run: node scripts/backfillLeadNotes.mjs
 */
import prisma from '../src/config/db.js';

const run = async () => {
  const leads = await prisma.lead.findMany({ include: { materialReq: true, dispatch: true } });
  const users = await prisma.user.findMany({ select: { id: true, name: true } });
  const userName = new Map(users.map((u) => [u.id, u.name]));

  let created = 0;
  let skipped = 0;

  const add = async (leadId, stage, body, authorId, at) => {
    const text = String(body ?? '').trim();
    if (!text) return;
    const exists = await prisma.leadNote.findFirst({ where: { leadId, stage, body: text } });
    if (exists) {
      skipped += 1;
      return;
    }
    await prisma.leadNote.create({
      data: {
        leadId,
        stage,
        body: text,
        authorId: authorId || null,
        authorName: authorId ? userName.get(authorId) || null : null,
        ...(at ? { createdAt: new Date(at) } : {}),
      },
    });
    created += 1;
  };

  for (const l of leads) {
    await add(l.id, 'LEAD', l.notes, l.createdById, l.createdAt);
    await add(l.id, 'FEASIBILITY', l.feasibilityNotes, l.feasibilityAssignedToId, l.feasibilityReviewedAt);
    await add(l.id, 'PRICING', l.pricing?.notes, l.assignedSalesId, null);
    await add(l.id, 'APPROVAL', l.approvalNotes, l.approvedById, l.approvedAt);
    await add(l.id, 'NOC_L2', l.nocL2ConfigNotes, l.nocL2AssignedToId, null);
    await add(l.id, 'AGGREGATOR', l.aggregatorConfirmRemark, l.assignedSalesId, null);
    if (Array.isArray(l.pipelineNotes)) {
      for (const pn of l.pipelineNotes) {
        await add(l.id, pn?.stage || 'GENERAL', pn?.note, pn?.by, pn?.at);
      }
    }
    if (l.materialReq?.notes) {
      await add(l.id, 'DELIVERY', l.materialReq.notes, l.materialReq.createdById, l.materialReq.createdAt);
    }
    if (l.dispatch?.notes) {
      await add(l.id, 'STORE', l.dispatch.notes, l.dispatch.dispatchedById, l.dispatch.dispatchedAt);
    }
  }

  console.log(`Backfill done: created ${created}, skipped ${skipped}.`);
  await prisma.$disconnect();
};

run().catch((e) => {
  console.error('[backfillLeadNotes]', e);
  process.exit(1);
});
