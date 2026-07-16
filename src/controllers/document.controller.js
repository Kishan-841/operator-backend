import prisma from '../config/db.js';
import { parsePagination, paginatedResponse } from '../utils/pagination.js';

// Public document shape (its lead comes from the parent row).
const docPublic = {
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
};

/**
 * GET /api/documents (admin) — GROUPED BY LEAD: one row per lead that has
 * matching documents, its documents nested (newest first). Search matches the
 * lead number, organisation, or any file name/label; the type filter narrows
 * which documents show AND which leads appear. Pagination counts leads.
 */
export const listAllDocuments = async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const term = req.query.search ? String(req.query.search).trim() : '';
    const type = req.query.type ? String(req.query.type).trim() : '';
    const company = req.query.company ? String(req.query.company).trim() : '';

    const docFilter = type ? { type } : {};
    const where = {
      documents: { some: docFilter },
      ...(company ? { organizationName: company } : {}),
      ...(term
        ? {
            OR: [
              { leadNumber: { contains: term, mode: 'insensitive' } },
              { organizationName: { contains: term, mode: 'insensitive' } },
              {
                documents: {
                  some: {
                    ...docFilter,
                    OR: [
                      { fileName: { contains: term, mode: 'insensitive' } },
                      { label: { contains: term, mode: 'insensitive' } },
                    ],
                  },
                },
              },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      prisma.lead.findMany({
        where,
        select: {
          id: true,
          leadNumber: true,
          organizationName: true,
          documents: { where: docFilter, select: docPublic, orderBy: { createdAt: 'desc' } },
        },
        orderBy: { leadNumber: 'desc' },
        skip,
        take: limit,
      }),
      prisma.lead.count({ where }),
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
