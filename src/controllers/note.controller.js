import prisma from '../config/db.js';
import { parsePagination, paginatedResponse } from '../utils/pagination.js';
import { isAdmin } from '../utils/roleHelper.js';
import { canAccessLead } from '../utils/leadAccess.js';
import { ROLE_NOTE_STAGES } from '../utils/leadVisibility.js';

const leadSelect = { lead: { select: { id: true, leadNumber: true, organizationName: true } } };

// Lead-ownership filter for the notes views: sales users are scoped to leads
// they own; admins and stage-based roles (NOC, delivery, …) see everything.
const salesLeadScope = (user) =>
  !isAdmin(user) && user?.role === 'SALES_USER' ? { assignedSalesId: user.id } : null;

// Stage roles read only the timeline stages relevant to their work (a pricing
// note shouldn't surface to the store user). Sales owners + admins see all.
const noteStageScope = (user) => {
  if (isAdmin(user) || user?.role === 'SALES_USER') return null;
  return { stage: { in: ROLE_NOTE_STAGES[user?.role] ?? [] } };
};

/** GET /api/leads/:id/notes — chronological note timeline for one lead. */
export const getLeadNotes = async (req, res) => {
  try {
    // Object-level access: sales must own the lead; stage roles only see leads
    // currently at their stage; admins see all. Unauthorized → empty timeline.
    const lead = await prisma.lead.findUnique({
      where: { id: req.params.id },
      select: { assignedSalesId: true, status: true },
    });
    if (!lead || !canAccessLead(req.user, lead)) return res.json({ items: [] });
    const items = await prisma.leadNote.findMany({
      where: { leadId: req.params.id, ...(noteStageScope(req.user) ?? {}) },
      orderBy: { createdAt: 'asc' },
    });
    return res.json({ items });
  } catch (error) {
    console.error('[notes.lead]', error);
    return res.status(500).json({ message: 'Failed to fetch notes.' });
  }
};

/** GET /api/notes — global feed: search + stage filter + pagination (newest first). */
export const listNotes = async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const term = req.query.search ? String(req.query.search).trim() : '';
    const stage = req.query.stage ? String(req.query.stage) : '';
    const company = req.query.company ? String(req.query.company).trim() : '';
    // Merge the sales-owner scope with the company filter into one `lead` clause
    // (separate `lead` keys would collide in the where object).
    const leadFilter = {
      ...salesLeadScope(req.user),
      ...(company ? { organizationName: company } : {}),
    };
    const roleScope = noteStageScope(req.user);
    const where = {
      // Role stage-scope ANDs with the user's explicit stage filter — a stage
      // outside the role's set simply yields nothing.
      ...(roleScope ? { AND: [roleScope] } : {}),
      ...(stage ? { stage } : {}),
      ...(Object.keys(leadFilter).length ? { lead: { is: leadFilter } } : {}),
      ...(term
        ? {
            OR: [
              { body: { contains: term, mode: 'insensitive' } },
              { authorName: { contains: term, mode: 'insensitive' } },
              { lead: { is: { leadNumber: { contains: term, mode: 'insensitive' } } } },
              { lead: { is: { organizationName: { contains: term, mode: 'insensitive' } } } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      prisma.leadNote.findMany({
        where,
        include: leadSelect,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.leadNote.count({ where }),
    ]);
    return res.json(paginatedResponse({ items, total, page, limit }));
  } catch (error) {
    console.error('[notes.list]', error);
    return res.status(500).json({ message: 'Failed to fetch notes.' });
  }
};

/** GET /api/notes/companies — distinct organizations that have notes (for the filter). */
export const listNoteCompanies = async (req, res) => {
  try {
    const leads = await prisma.lead.findMany({
      where: { noteEntries: { some: {} }, ...salesLeadScope(req.user) },
      select: { organizationName: true },
      distinct: ['organizationName'],
      orderBy: { organizationName: 'asc' },
    });
    return res.json({ items: leads.map((l) => l.organizationName).filter(Boolean) });
  } catch (error) {
    console.error('[notes.companies]', error);
    return res.status(500).json({ message: 'Failed to fetch companies.' });
  }
};
