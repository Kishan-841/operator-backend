import prisma from '../config/db.js';
import * as svc from '../services/agreement.service.js';
import { readFileBuffer } from '../services/storage.service.js';
import { generateCafNumber } from '../services/leadNumber.service.js';
import { assertLeadAccess } from '../utils/leadAccess.js';
import { isAdmin } from '../utils/roleHelper.js';

// Generation is only meaningful once the lead has reached the agreement stage —
// this is what protects the CAF number from being burned early.
const AGREEMENT_STAGES = ['AGREEMENT_PENDING', 'AGREEMENT_SENT_FOR_SIGNATURE', 'COMPLETED'];

/**
 * POST /api/leads/:id/agreement/generate (SOFTWARE / SALES)
 * { orgName, orgAddress?, orgOwnerName?, agreementDate?, attachDocumentIds? }
 * attachDocumentIds — LeadDocument ids (of THIS lead) whose files are appended
 * to the end of the generated PDF, before any manually uploaded attachments.
 */
export const generateAgreement = async (req, res) => {
  try {
    const lead = await prisma.lead.findUnique({
      where: { id: req.params.id },
      select: { id: true, leadNumber: true, category: true, cafNumber: true, status: true, assignedSalesId: true },
    });
    if (!lead) return res.status(404).json({ message: 'Lead not found.' });
    // Object-level access: a sales user must own the lead; a software user must
    // be at one of their stages. Throws a 404 (never revealing existence).
    assertLeadAccess(req.user, lead);
    // Stage guard: don't stamp/CAF-burn a lead that isn't at the agreement stage.
    if (!isAdmin(req.user) && !AGREEMENT_STAGES.includes(lead.status)) {
      return res.status(400).json({ message: 'This lead has not reached the agreement stage yet.' });
    }
    const isIsp = lead.category === 'ISP';

    const orgName = String(req.body?.orgName || '').trim();
    if (!orgName) return res.status(400).json({ message: 'Organization name is required.' });

    // Optional execution date ('YYYY-MM-DD' from the modal) — defaults to today.
    const rawDate = req.body?.agreementDate;
    let agreementDate = new Date();
    if (rawDate !== undefined && rawDate !== null && rawDate !== '') {
      agreementDate = new Date(rawDate);
      if (Number.isNaN(agreementDate.getTime())) {
        return res.status(400).json({ message: 'agreementDate must be a valid date.' });
      }
    }

    // Already-uploaded lead documents selected in the modal. Multipart repeats
    // the field per id (string when only one); JSON sends an array.
    const rawIds = req.body?.attachDocumentIds;
    const ids = [...new Set(Array.isArray(rawIds) ? rawIds : rawIds ? [rawIds] : [])].filter(
      (v) => typeof v === 'string' && v.trim(),
    );
    const docAttachments = [];
    if (ids.length) {
      // Scoped to THIS lead — an id belonging to another lead is a 400, never a leak.
      const docs = await prisma.leadDocument.findMany({
        where: { id: { in: ids }, leadId: req.params.id },
        select: { id: true, fileName: true, storageKey: true, mimeType: true },
      });
      if (docs.length !== ids.length) {
        return res.status(400).json({ message: 'One or more selected documents no longer exist on this lead.' });
      }
      // Keep the user's selection order (docs come back unordered).
      const byId = new Map(docs.map((d) => [d.id, d]));
      for (const id of ids) {
        const doc = byId.get(id);
        const fileBuffer = await readFileBuffer(doc.storageKey);
        if (!fileBuffer) {
          return res.status(400).json({ message: `The stored file for "${doc.fileName}" is missing.` });
        }
        docAttachments.push({ buffer: fileBuffer, mimetype: doc.mimeType, originalname: doc.fileName });
      }
    }

    // ISP leads get the SLA template with an auto-assigned CAF number — claimed
    // once (conditional updateMany so racing generates can't double-assign) and
    // fixed for the lead's lifetime.
    let cafNumber = lead.cafNumber;
    if (isIsp && !cafNumber) {
      const fresh = await generateCafNumber();
      const { count } = await prisma.lead.updateMany({
        where: { id: lead.id, cafNumber: null },
        data: { cafNumber: fresh },
      });
      cafNumber = count
        ? fresh
        : (await prisma.lead.findUnique({ where: { id: lead.id }, select: { cafNumber: true } })).cafNumber;
    }

    const { buffer, ext, contentType } = await svc.generateAgreement(
      isIsp
        ? { customerName: orgName, officeAddress: req.body?.orgAddress, effectiveDate: agreementDate, cafNumber }
        : { orgName, orgAddress: req.body?.orgAddress, orgOwnerName: req.body?.orgOwnerName, agreementDate },
      [...docAttachments, ...(req.files || [])],
      isIsp ? 'ISP_SLA' : 'FRANCHISE',
    );

    // Soft-stamp when the agreement was generated (drives the queue's step
    // checklist) — never block the download over it.
    try {
      await prisma.lead.update({
        where: { id: req.params.id },
        data: { agreementGeneratedAt: new Date() },
      });
    } catch (e) {
      console.warn('[agreement.generate] could not stamp agreementGeneratedAt:', e?.message);
    }

    const filename = `${lead.leadNumber}-${isIsp ? 'sla' : 'agreement'}.${ext}`;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(buffer);
  } catch (error) {
    if (error?.status === 404) return res.status(404).json({ message: error.message });
    if (error?.status === 400) return res.status(400).json({ message: error.message });
    console.error('[agreement.generate]', error?.message || error);
    return res.status(500).json({ message: 'Failed to generate the agreement.' });
  }
};
