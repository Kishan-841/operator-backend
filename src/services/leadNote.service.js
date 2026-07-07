import prisma from '../config/db.js';

/**
 * Record a per-stage note in a lead's timeline. Soft-fail: a notes error must
 * never roll back the primary business operation (mirrors logStatusChange).
 * `actor` is the request actor ({ id, label }). No-op for empty bodies.
 */
export const addLeadNote = async ({ leadId, stage, body, actor }) => {
  const text = String(body ?? '').trim();
  if (!leadId || !text) return;
  try {
    await prisma.leadNote.create({
      data: {
        leadId,
        stage: stage || 'GENERAL',
        body: text,
        authorId: actor?.id ?? null,
        authorName: actor?.label ?? actor?.name ?? null,
      },
    });
  } catch (e) {
    console.warn('[leadNote] failed to record note:', e?.message || e);
  }
};
