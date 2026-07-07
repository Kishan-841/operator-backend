import prisma from '../config/db.js';
import { logEvent } from '../services/statusChangeLog.service.js';
import { actorFromReq } from '../utils/requestContext.js';

/** GET /api/document-types */
export const listDocumentTypes = async (_req, res) => {
  try {
    const items = await prisma.documentType.findMany({ orderBy: { name: 'asc' } });
    return res.json({ items });
  } catch (error) {
    console.error('[docType.list]', error);
    return res.status(500).json({ message: 'Failed to fetch document types.' });
  }
};

/** POST /api/document-types { name } — idempotent on name. */
export const createDocumentType = async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ message: 'A name is required.' });

    const existing = await prisma.documentType.findUnique({ where: { name } });
    if (existing) return res.json({ message: 'Already exists.', data: existing });

    const data = await prisma.documentType.create({ data: { name } });

    await logEvent({
      action: 'DOCTYPE_CREATED',
      entityType: 'DocumentType',
      entityId: data.id,
      summary: `Created document type "${name}"`,
      actor: actorFromReq(req),
    });
    return res.status(201).json({ message: 'Document type created.', data });
  } catch (error) {
    console.error('[docType.create]', error);
    return res.status(500).json({ message: 'Failed to create document type.' });
  }
};
