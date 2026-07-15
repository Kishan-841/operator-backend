import prisma from '../config/db.js';
import { notifyRoles, notifyOneUser, refreshSidebarForRoles } from '../services/notification.service.js';
import { logEvent } from '../services/statusChangeLog.service.js';
import { actorFromReq } from '../utils/requestContext.js';

const ADMIN_ROLES = ['SUPER_ADMIN', 'ADMIN'];

/**
 * POST /api/leads/duplicate-approvals (SALES)
 * { email, phone?, organizationName?, reason? }
 * Ask admin to allow creating a duplicate lead (same email/mobile — e.g. the
 * same franchise at a second location). Refused when nothing actually clashes.
 */
export const requestDuplicateApproval = async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const phone = String(req.body?.phone || '').trim() || null;
    if (!email) return res.status(400).json({ message: 'Email is required.' });

    const or = [{ email: { equals: email, mode: 'insensitive' } }];
    if (phone) or.push({ phone });
    const dupe = await prisma.lead.findFirst({
      where: { status: { not: 'REJECTED' }, OR: or },
      select: { leadNumber: true },
    });
    if (!dupe) {
      return res.status(400).json({ message: 'No existing lead uses these contact details — just create the lead normally.' });
    }

    const open = await prisma.duplicateLeadApproval.findFirst({
      where: { email, phone, requestedById: req.user.id, status: 'PENDING' },
      select: { id: true },
    });
    if (open) {
      return res.status(409).json({ message: 'An approval request for these contact details is already pending.' });
    }

    const approval = await prisma.duplicateLeadApproval.create({
      data: {
        email,
        phone,
        organizationName: String(req.body?.organizationName || '').trim() || null,
        reason: String(req.body?.reason || '').trim() || null,
        duplicateOfLeadNumber: dupe.leadNumber,
        requestedById: req.user.id,
      },
    });

    await logEvent({
      action: 'DUPLICATE_APPROVAL_REQUESTED',
      entityType: 'DuplicateLeadApproval',
      entityId: approval.id,
      summary: `Requested duplicate-lead approval for ${email} (clashes with ${dupe.leadNumber})`,
      actor: actorFromReq(req),
    });
    await notifyRoles(ADMIN_ROLES, {
      type: 'DUPLICATE_APPROVAL',
      title: `Duplicate lead approval requested (${dupe.leadNumber})`,
      message: `${email}${phone ? ` · ${phone}` : ''}`,
    });
    await refreshSidebarForRoles(ADMIN_ROLES);

    return res.status(201).json({ message: 'Sent to admin for approval.', data: approval });
  } catch (error) {
    console.error('[dupApproval.request]', error);
    return res.status(500).json({ message: 'Failed to send the approval request.' });
  }
};

/** GET /api/leads/duplicate-approvals?status=PENDING (ADMIN) */
export const listDuplicateApprovals = async (req, res) => {
  try {
    const status = ['PENDING', 'APPROVED', 'REJECTED'].includes(req.query.status) ? req.query.status : 'PENDING';
    const items = await prisma.duplicateLeadApproval.findMany({
      where: { status },
      orderBy: { createdAt: 'desc' },
      include: {
        requestedBy: { select: { id: true, name: true } },
        decidedBy: { select: { id: true, name: true } },
      },
    });
    return res.json({ items });
  } catch (error) {
    console.error('[dupApproval.list]', error);
    return res.status(500).json({ message: 'Failed to fetch duplicate requests.' });
  }
};

const decide = async (req, res, { approve, reason }) => {
  const approval = await prisma.duplicateLeadApproval.findUnique({ where: { id: req.params.approvalId } });
  if (!approval) return res.status(404).json({ message: 'Request not found.' });
  if (approval.status !== 'PENDING') {
    return res.status(409).json({ message: 'This request has already been decided.' });
  }
  const updated = await prisma.duplicateLeadApproval.update({
    where: { id: approval.id },
    data: {
      status: approve ? 'APPROVED' : 'REJECTED',
      decidedById: req.user.id,
      decidedAt: new Date(),
      rejectedReason: approve ? null : reason,
    },
  });
  await logEvent({
    action: approve ? 'DUPLICATE_APPROVAL_GRANTED' : 'DUPLICATE_APPROVAL_REJECTED',
    entityType: 'DuplicateLeadApproval',
    entityId: approval.id,
    summary: `${approve ? 'Approved' : 'Rejected'} duplicate-lead request for ${approval.email}${approve ? '' : ` — ${reason}`}`,
    actor: actorFromReq(req),
  });
  await notifyOneUser(approval.requestedById, {
    type: 'DUPLICATE_APPROVAL',
    title: approve
      ? 'Duplicate lead approved — you can create it now'
      : 'Duplicate lead request rejected',
    message: approve ? `${approval.email} (one creation)` : reason,
  });
  await refreshSidebarForRoles(ADMIN_ROLES);
  return res.json({ message: approve ? 'Approved.' : 'Rejected.', data: updated });
};

/** POST /api/leads/duplicate-approvals/:approvalId/approve (ADMIN) */
export const approveDuplicateApproval = async (req, res) => {
  try {
    return await decide(req, res, { approve: true });
  } catch (error) {
    console.error('[dupApproval.approve]', error);
    return res.status(500).json({ message: 'Failed to approve the request.' });
  }
};

/** POST /api/leads/duplicate-approvals/:approvalId/reject (ADMIN) { reason } */
export const rejectDuplicateApproval = async (req, res) => {
  try {
    const reason = String(req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ message: 'A reason is required to reject the request.' });
    return await decide(req, res, { approve: false, reason });
  } catch (error) {
    console.error('[dupApproval.reject]', error);
    return res.status(500).json({ message: 'Failed to reject the request.' });
  }
};
