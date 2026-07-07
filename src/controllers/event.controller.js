import prisma from '../config/db.js';
import { parsePagination, paginatedResponse } from '../utils/pagination.js';

const VALID_ENTITY_TYPES = ['Lead', 'User', 'DocumentType', 'PopLocation', 'Auth'];

/** GET /api/events (admin) — the event log: paginated + filterable. */
export const getEvents = async (req, res) => {
  try {
    const { action, entityType, changedById, dateFrom, dateTo } = req.query;
    const term = req.query.q ? String(req.query.q).trim() : '';
    const { page, limit, skip } = parsePagination(req.query);

    const where = {};
    if (action) where.action = action;
    if (entityType && VALID_ENTITY_TYPES.includes(entityType)) where.entityType = entityType;
    if (changedById) where.changedById = changedById;
    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) where.createdAt.gte = new Date(dateFrom);
      if (dateTo) {
        const end = new Date(dateTo);
        end.setHours(23, 59, 59, 999); // inclusive end-of-day
        where.createdAt.lte = end;
      }
    }

    // Free-text search across summary / ip / actor label / actor name / reason,
    // plus lead-number lookup (resolve matching lead ids first).
    if (term) {
      const matchedLeads = await prisma.lead.findMany({
        where: { leadNumber: { contains: term, mode: 'insensitive' } },
        select: { id: true },
      });
      const leadIds = matchedLeads.map((l) => l.id);
      where.OR = [
        { summary: { contains: term, mode: 'insensitive' } },
        { reason: { contains: term, mode: 'insensitive' } },
        { ipAddress: { contains: term, mode: 'insensitive' } },
        { actorLabel: { contains: term, mode: 'insensitive' } },
        { changedBy: { is: { name: { contains: term, mode: 'insensitive' } } } },
        ...(leadIds.length ? [{ entityId: { in: leadIds } }] : []),
      ];
    }

    const [rows, total] = await Promise.all([
      prisma.statusChangeLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: { changedBy: { select: { id: true, name: true, role: true } } },
      }),
      prisma.statusChangeLog.count({ where }),
    ]);

    // Resolve lead number / org for the Lead rows on this page.
    const leadIds = [...new Set(rows.filter((r) => r.entityType === 'Lead' && r.entityId).map((r) => r.entityId))];
    const leads = leadIds.length
      ? await prisma.lead.findMany({
          where: { id: { in: leadIds } },
          select: { id: true, leadNumber: true, organizationName: true },
        })
      : [];
    const leadMap = Object.fromEntries(leads.map((l) => [l.id, l]));

    const items = rows.map((r) => ({
      id: r.id,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      leadNumber: leadMap[r.entityId]?.leadNumber || null,
      organizationName: leadMap[r.entityId]?.organizationName || null,
      summary: r.summary,
      changes: r.changes || null,
      oldValue: r.oldValue,
      newValue: r.newValue,
      reason: r.reason,
      changedBy: r.changedBy,
      actorLabel: r.actorLabel,
      ipAddress: r.ipAddress,
      createdAt: r.createdAt,
    }));

    return res.json(paginatedResponse({ items, total, page, limit }));
  } catch (error) {
    console.error('[event.get]', error);
    return res.status(500).json({ message: 'Failed to fetch event log.' });
  }
};
