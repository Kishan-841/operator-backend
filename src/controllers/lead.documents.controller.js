import prisma from '../config/db.js';
import { saveBuffer, sendDownload, removeFile } from '../services/storage.service.js';
import { logEvent } from '../services/statusChangeLog.service.js';
import { actorFromReq } from '../utils/requestContext.js';
import { assertLeadAccess } from '../utils/leadAccess.js';
import { canonicalDocType } from '../utils/documentTypes.js';
import { handleError } from '../utils/logger.js';
import * as sm from '../services/leadStateMachine.js';

const docPublic = {
  id: true,
  type: true,
  label: true,
  fileName: true,
  mimeType: true,
  size: true,
  createdAt: true,
  uploadedBy: { select: { id: true, name: true } },
  verificationStatus: true,
  verificationNote: true,
  verifiedAt: true,
  verifiedBy: { select: { id: true, name: true } },
  salesApprovedAt: true,
};

/** POST /api/leads/:id/documents (multipart: file, type?, label?) */
export const uploadDocument = async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.file) return res.status(400).json({ message: 'A file is required.' });

    const lead = await prisma.lead.findUnique({
      where: { id },
      select: { id: true, leadNumber: true, assignedSalesId: true, status: true },
    });
    if (!lead) return res.status(404).json({ message: 'Lead not found.' });
    assertLeadAccess(req.user, lead);

    // Type comes from the (extensible) DocumentType list; canonicalise so the
    // agreement type is stored as the exact value the close gate matches on.
    const type = canonicalDocType(req.body.type);
    // leadNumber + type shape the storage key (leads/OPC-0009/GST/…) so the
    // bucket/uploads dir stays organised per lead, per document type.
    const { storageKey, size } = await saveBuffer({
      buffer: req.file.buffer,
      originalName: req.file.originalname,
      contentType: req.file.mimetype,
      leadId: id,
      leadNumber: lead.leadNumber,
      docType: type,
    });

    const doc = await prisma.leadDocument.create({
      data: {
        leadId: id,
        type,
        label: req.body.label || null,
        fileName: req.file.originalname,
        storageKey,
        mimeType: req.file.mimetype,
        size,
        uploadedById: req.user.id,
      },
      select: docPublic,
    });

    // Logged against the Lead so the event resolves to a lead number in the UI.
    await logEvent({
      action: 'DOC_UPLOADED',
      entityType: 'Lead',
      entityId: id,
      summary: `Uploaded document "${doc.fileName}" (${type})`,
      actor: actorFromReq(req),
    });
    return res.status(201).json({ message: 'Document uploaded.', data: doc });
  } catch (error) {
    return handleError(res, error, 'doc.upload', 'Upload failed.');
  }
};

/** GET /api/leads/:id/documents */
export const listDocuments = async (req, res) => {
  try {
    const lead = await prisma.lead.findUnique({
      where: { id: req.params.id },
      select: { id: true, assignedSalesId: true, status: true },
    });
    if (!lead) return res.status(404).json({ message: 'Lead not found.' });
    assertLeadAccess(req.user, lead);

    const items = await prisma.leadDocument.findMany({
      where: { leadId: req.params.id },
      select: docPublic,
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ items });
  } catch (error) {
    return handleError(res, error, 'doc.list', 'Failed to fetch documents.');
  }
};

/** GET /api/leads/:id/documents/:docId/download */
export const downloadDocument = async (req, res) => {
  try {
    const doc = await prisma.leadDocument.findFirst({
      where: { id: req.params.docId, leadId: req.params.id },
      include: { lead: { select: { assignedSalesId: true, status: true } } },
    });
    if (!doc) return res.status(404).json({ message: 'Document not found.' });
    assertLeadAccess(req.user, doc.lead);
    return await sendDownload(res, doc);
  } catch (error) {
    return handleError(res, error, 'doc.download', 'Download failed.');
  }
};

const VERIFICATION_STATUSES = ['PENDING', 'VERIFIED', 'REJECTED'];

/**
 * PATCH /api/leads/:id/documents/:docId/verification (SOFTWARE) { status, note? }
 * REJECTED additionally sends the lead back to the sales Docs stage (with the
 * note as the reason) via the state machine.
 */
export const setDocumentVerification = async (req, res) => {
  try {
    const status = String(req.body.status || '').toUpperCase();
    if (!VERIFICATION_STATUSES.includes(status)) {
      return res.status(400).json({ message: 'Invalid verification status.' });
    }
    const note = req.body.note ? String(req.body.note).trim() : null;
    if (status === 'REJECTED' && !note) {
      return res.status(400).json({ message: 'A reason is required when rejecting a document.' });
    }

    const lead = await prisma.lead.findUnique({
      where: { id: req.params.id },
      select: { status: true },
    });
    if (!lead) return res.status(404).json({ message: 'Lead not found.' });
    // Per-doc verify/reject is a stage-5b activity — guard so it can't be
    // applied before sales sends the docs, or after the lead has moved on.
    if (lead.status !== 'DOCS_UPLOADED') {
      return res
        .status(409)
        .json({ message: 'Documents can only be verified while the lead is awaiting docs verification.' });
    }

    const doc = await prisma.leadDocument.findFirst({
      where: { id: req.params.docId, leadId: req.params.id },
      select: { id: true, fileName: true },
    });
    if (!doc) return res.status(404).json({ message: 'Document not found.' });

    // Rejection sends the lead back to the sales Docs stage. Do the lead
    // transition FIRST — it's atomic and throws 409 on a race — so a failed or
    // raced transition can never leave an orphaned REJECTED doc on a lead that
    // already moved on. Only stamp the doc once the transition has committed.
    if (status === 'REJECTED') {
      const data = await sm.rejectDocs({
        leadId: req.params.id,
        actor: actorFromReq(req),
        reason: note,
      });
      const updated = await prisma.leadDocument.update({
        where: { id: doc.id },
        data: {
          verificationStatus: 'REJECTED',
          verificationNote: note,
          verifiedById: req.user.id,
          verifiedAt: new Date(),
        },
        select: docPublic,
      });
      await logEvent({
        action: 'DOC_REJECTED',
        entityType: 'Lead',
        entityId: req.params.id,
        summary: `Rejected document "${doc.fileName}"${note ? ` — ${note}` : ''}`,
        actor: actorFromReq(req),
      });
      return res.json({
        message: 'Document rejected — lead sent back to the docs stage.',
        data: updated,
        lead: data,
      });
    }

    // VERIFIED / PENDING — no lead transition, just stamp the document.
    const cleared = status === 'PENDING';
    const updated = await prisma.leadDocument.update({
      where: { id: doc.id },
      data: {
        verificationStatus: status,
        verificationNote: null,
        verifiedById: cleared ? null : req.user.id,
        verifiedAt: cleared ? null : new Date(),
      },
      select: docPublic,
    });
    await logEvent({
      action: status === 'VERIFIED' ? 'DOC_VERIFIED' : 'DOC_UNVERIFIED',
      entityType: 'Lead',
      entityId: req.params.id,
      summary: `${status === 'VERIFIED' ? 'Verified' : 'Reset verification on'} document "${doc.fileName}"`,
      actor: actorFromReq(req),
    });
    return res.json({ message: 'Verification updated.', data: updated });
  } catch (error) {
    // State-machine errors carry an intended HTTP status (409 race, 400 input).
    return handleError(res, error, 'doc.verify', 'Failed to update verification.');
  }
};

/** DELETE /api/leads/:id/documents/:docId */
export const deleteDocument = async (req, res) => {
  try {
    const doc = await prisma.leadDocument.findFirst({
      where: { id: req.params.docId, leadId: req.params.id },
      include: { lead: { select: { status: true, assignedSalesId: true } } },
    });
    if (!doc) return res.status(404).json({ message: 'Document not found.' });
    assertLeadAccess(req.user, doc.lead);
    // Never remove documents from a closed lead — preserves the signed agreement
    // and other evidence on COMPLETED/REJECTED deals.
    if (['COMPLETED', 'REJECTED'].includes(doc.lead.status)) {
      return res.status(409).json({ message: 'Documents on a closed lead cannot be deleted.' });
    }
    await prisma.leadDocument.delete({ where: { id: doc.id } });
    await removeFile(doc.storageKey);

    await logEvent({
      action: 'DOC_DELETED',
      entityType: 'Lead',
      entityId: req.params.id,
      summary: `Deleted document "${doc.fileName}"`,
      actor: actorFromReq(req),
    });
    return res.json({ message: 'Document deleted.' });
  } catch (error) {
    return handleError(res, error, 'doc.delete', 'Delete failed.');
  }
};

/**
 * PATCH /api/leads/:id/documents/:docId/sales-approve (SALES) { approved: boolean }
 * Sales verifies an uploaded document at the docs stage. The lead can't leave the
 * docs stage until every uploaded document is approved (see completeDocs).
 */
export const setDocumentSalesApproval = async (req, res) => {
  try {
    const approved = req.body?.approved !== false; // default true
    const lead = await prisma.lead.findUnique({
      where: { id: req.params.id },
      select: { assignedSalesId: true, status: true },
    });
    if (!lead) return res.status(404).json({ message: 'Lead not found.' });
    assertLeadAccess(req.user, lead);
    if (lead.status !== 'DOCS_UPLOADED') {
      return res
        .status(409)
        .json({ message: 'Documents can only be approved once sales has sent them for verification.' });
    }
    const doc = await prisma.leadDocument.findFirst({
      where: { id: req.params.docId, leadId: req.params.id },
      select: { id: true, fileName: true },
    });
    if (!doc) return res.status(404).json({ message: 'Document not found.' });

    const updated = await prisma.leadDocument.update({
      where: { id: doc.id },
      data: {
        salesApprovedAt: approved ? new Date() : null,
        salesApprovedById: approved ? req.user.id : null,
      },
      select: docPublic,
    });
    await logEvent({
      action: approved ? 'DOC_SALES_APPROVED' : 'DOC_SALES_UNAPPROVED',
      entityType: 'Lead',
      entityId: req.params.id,
      summary: `${approved ? 'Approved' : 'Unapproved'} document "${doc.fileName}"`,
      actor: actorFromReq(req),
    });
    return res.json({ message: 'Approval updated.', data: updated });
  } catch (error) {
    return handleError(res, error, 'doc.salesApprove', 'Failed to update approval.');
  }
};
