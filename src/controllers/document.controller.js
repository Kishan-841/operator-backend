import prisma from '../config/db.js';
import { parsePagination, paginatedResponse } from '../utils/pagination.js';

// Public document shape + its lead, for the admin documents browser.
const docWithLead = {
  id: true,
  type: true,
  label: true,
  fileName: true,
  mimeType: true,
  size: true,
  createdAt: true,
  verificationStatus: true,
  verificationNote: true,
  verifiedAt: true,
  uploadedBy: { select: { id: true, name: true } },
  verifiedBy: { select: { id: true, name: true } },
  lead: { select: { id: true, leadNumber: true, organizationName: true } },
};

/**
 * GET /api/documents (admin) — every uploaded lead document, newest first.
 * Search (lead #, organisation, file name) + type + company filters + pagination.
 * Lets admins retrieve any doc — GST/PAN, agreements, etc. — lead-wise.
 */
export const listAllDocuments = async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const term = req.query.search ? String(req.query.search).trim() : '';
    const type = req.query.type ? String(req.query.type).trim() : '';
    const company = req.query.company ? String(req.query.company).trim() : '';

    const where = {
      ...(type ? { type } : {}),
      ...(company ? { lead: { is: { organizationName: company } } } : {}),
      ...(term
        ? {
            OR: [
              { fileName: { contains: term, mode: 'insensitive' } },
              { label: { contains: term, mode: 'insensitive' } },
              { lead: { is: { leadNumber: { contains: term, mode: 'insensitive' } } } },
              { lead: { is: { organizationName: { contains: term, mode: 'insensitive' } } } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.leadDocument.findMany({
        where,
        select: docWithLead,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.leadDocument.count({ where }),
    ]);
    return res.json(paginatedResponse({ items, total, page, limit }));
  } catch (error) {
    console.error('[documents.list]', error);
    return res.status(500).json({ message: 'Failed to fetch documents.' });
  }
};

/** GET /api/documents/companies — distinct organisations that have documents. */
export const listDocumentCompanies = async (_req, res) => {
  try {
    const leads = await prisma.lead.findMany({
      where: { documents: { some: {} } },
      select: { organizationName: true },
      distinct: ['organizationName'],
      orderBy: { organizationName: 'asc' },
    });
    return res.json({ items: leads.map((l) => l.organizationName).filter(Boolean) });
  } catch (error) {
    console.error('[documents.companies]', error);
    return res.status(500).json({ message: 'Failed to fetch companies.' });
  }
};

/** GET /api/documents/types — distinct document types present (for the filter). */
export const listDocumentTypes = async (_req, res) => {
  try {
    const rows = await prisma.leadDocument.findMany({
      select: { type: true },
      distinct: ['type'],
      orderBy: { type: 'asc' },
    });
    return res.json({ items: rows.map((r) => r.type).filter(Boolean) });
  } catch (error) {
    console.error('[documents.types]', error);
    return res.status(500).json({ message: 'Failed to fetch types.' });
  }
};
