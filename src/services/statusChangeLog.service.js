import prisma from '../config/db.js';

/**
 * Unified event logging. Soft-fail by design (CLAUDE.md §3): a logging error must
 * never roll back the business operation that triggered it.
 *
 * `actor` is the request context: { id?, email?, label?, ip?, userAgent? }.
 */
export const logEvent = async ({
  action = 'STATUS_CHANGED',
  entityType,
  entityId = null,
  summary = null,
  changes = null,
  oldValue = null,
  newValue = null,
  reason = null,
  actor = null,
  salesOwnerId = undefined, // caller may pass it; otherwise resolved for Lead events
}) => {
  try {
    // Denormalise the lead's sales owner so scoped reports can filter the log
    // directly. Resolve it when the caller didn't supply it (cheap PK lookup).
    let owner = salesOwnerId;
    if (owner === undefined && entityType === 'Lead' && entityId) {
      const lead = await prisma.lead.findUnique({
        where: { id: entityId },
        select: { assignedSalesId: true },
      });
      owner = lead?.assignedSalesId ?? null;
    }
    const data = {
      action,
      entityType,
      entityId: entityId ?? null,
      summary: summary ?? null,
      oldValue: oldValue ?? null,
      newValue: newValue ?? null,
      reason: reason ?? null,
      changedById: actor?.id ?? null,
      actorLabel: actor?.label ?? null,
      ipAddress: actor?.ip ?? null,
      userAgent: actor?.userAgent ?? null,
      salesOwnerId: owner ?? null,
    };
    // Only set the Json column when present — avoids Prisma's JSON-null gotcha.
    if (changes != null && (!Array.isArray(changes) || changes.length > 0)) {
      data.changes = changes;
    }
    await prisma.statusChangeLog.create({ data });
  } catch (error) {
    console.warn('[eventLog] non-fatal:', error?.message);
  }
};

/**
 * Pipeline status-change shim — the state machine calls this; it's just a tagged
 * logEvent so all transitions land in the same log with action STATUS_CHANGED.
 */
export const logStatusChange = ({ entityType, entityId, oldValue, newValue, reason, actor }) =>
  logEvent({ action: 'STATUS_CHANGED', entityType, entityId, oldValue, newValue, reason, actor });

/**
 * Build a `[{ field, from, to }]` diff of the fields that actually changed between
 * two records. Compares with a stable stringify so object/array fields work too.
 */
export const diffFields = (before, after, fields) => {
  const norm = (v) => (v && typeof v === 'object' ? JSON.stringify(v) : v);
  const changes = [];
  for (const field of fields) {
    const from = before?.[field];
    const to = after?.[field];
    if (norm(from) !== norm(to)) {
      changes.push({
        field,
        from: from === undefined ? null : from,
        to: to === undefined ? null : to,
      });
    }
  }
  return changes;
};
