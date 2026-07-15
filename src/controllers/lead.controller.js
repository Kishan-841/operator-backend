import prismaPkg from '@prisma/client';
import prisma from '../config/db.js';
import { parsePagination, paginatedResponse } from '../utils/pagination.js';
import { validateLeadPayload, LEAD_CATEGORIES } from '../validation/leadCategories.js';
import { validateIpDetails } from '../validation/ipDetails.js';
import { generateLeadNumber } from '../services/leadNumber.service.js';
import { ensureDefaultDistributor } from './distributor.controller.js';
import { logEvent, diffFields } from '../services/statusChangeLog.service.js';
import { addLeadNote } from '../services/leadNote.service.js';
import { stripLeadForRole, stripLeadsForRole } from '../utils/leadVisibility.js';
import { actorFromReq } from '../utils/requestContext.js';
import { isAdmin } from '../utils/roleHelper.js';

// Lead fields worth diffing in the event log (scalars + the requirement blob).
const LEAD_DIFF_FIELDS = [
  'category', 'organizationName', 'email', 'contactPersonName', 'phone', 'territory',
  'annualRevenue', 'website', 'whatsappNumber', 'existingServiceProvider', 'gender',
  'areaName', 'city', 'state', 'pincode', 'latitude', 'longitude', 'sourceOfLead',
  'customerInterestLevel', 'notes', 'requirementDetails',
];

const { LeadStatus } = prismaPkg;
const VALID_STATUSES = Object.values(LeadStatus);

const creatorSelect = {
  createdBy: { select: { id: true, name: true, email: true } },
  assignedSales: { select: { id: true, name: true } },
  popLocation: { select: { id: true, name: true, latitude: true, longitude: true } },
  distributor: { select: { id: true, name: true, isDefault: true } },
};

// Owner of the lead: admins may hand it to an active SALES_USER; everyone else
// (and admins who don't pick) owns what they create. Throws 400 on a bad target.
const resolveOwnerId = async (req, fallbackId) => {
  const rawId = req.body?.assignedSalesId;
  if (!isAdmin(req.user) || typeof rawId !== 'string' || !rawId.trim()) return fallbackId;
  const target = await prisma.user.findUnique({
    where: { id: rawId.trim() },
    select: { id: true, role: true, isActive: true },
  });
  // Valid owners: an active sales user, or the acting admin themselves ("Me").
  if (!target || !target.isActive || (target.role !== 'SALES_USER' && target.id !== req.user.id)) {
    const err = new Error('Pick an active sales user as the lead owner.');
    err.status = 400;
    throw err;
  }
  return target.id;
};

// Resolve the lead's distributor: explicit pick must exist; no pick → GAZON.
const resolveDistributorId = async (rawId) => {
  const id = typeof rawId === 'string' && rawId.trim() ? rawId.trim() : null;
  if (id) {
    const found = await prisma.distributor.findUnique({ where: { id }, select: { id: true } });
    if (!found) {
      const err = new Error('The selected distributor no longer exists.');
      err.status = 400;
      throw err;
    }
    return id;
  }
  return (await ensureDefaultDistributor()).id;
};

/** POST /api/leads — create a NEW lead with an atomically-generated number. */
// A lead is a duplicate when its email or mobile number matches an existing
// lead. REJECTED leads don't block — a franchise turned down earlier may
// legitimately be re-created later.
const findDuplicateLead = async ({ email, phone }, excludeId) => {
  const or = [];
  if (email) or.push({ email: { equals: email, mode: 'insensitive' } });
  if (phone) or.push({ phone });
  if (!or.length) return null;
  return prisma.lead.findFirst({
    where: {
      status: { not: 'REJECTED' },
      OR: or,
      ...(excludeId ? { NOT: { id: excludeId } } : {}),
    },
    select: { leadNumber: true, email: true, phone: true },
  });
};

const duplicateErrors = (dupe, { email, phone }) => {
  const errors = [];
  if (email && dupe.email?.toLowerCase() === email.toLowerCase()) {
    errors.push({ path: 'email', message: `A lead with this email already exists (${dupe.leadNumber}).` });
  }
  if (phone && dupe.phone === phone) {
    errors.push({ path: 'phone', message: `A lead with this mobile number already exists (${dupe.leadNumber}).` });
  }
  return errors.length ? errors : [{ path: 'email', message: `Duplicate of lead ${dupe.leadNumber}.` }];
};

export const createLead = async (req, res) => {
  try {
    const result = validateLeadPayload(req.body);
    if (!result.ok) {
      return res.status(400).json({ message: 'Validation failed.', errors: result.errors });
    }
    const { category, requirementDetails, ...contact } = result.data;

    const dupe = await findDuplicateLead(contact);
    // Admins aren't silently exempt: they get the duplicate error too, but may
    // resubmit with allowDuplicate (the form's "Create anyway") — no approval
    // request needed since they ARE the approver.
    if (dupe && isAdmin(req.user) && req.body?.allowDuplicate !== true) {
      return res.status(400).json({
        message: `This lead already exists (${dupe.leadNumber}).`,
        errors: duplicateErrors(dupe, contact),
        duplicate: { leadNumber: dupe.leadNumber, approvalStatus: 'ADMIN_OVERRIDE', rejectedReason: null },
      });
    }
    // An admin-APPROVED duplicate request (by this user, for exactly this
    // email+mobile, not yet spent) unlocks ONE duplicate creation.
    let exception = null;
    if (dupe && !isAdmin(req.user)) {
      exception = await prisma.duplicateLeadApproval.findFirst({
        where: {
          status: 'APPROVED',
          consumedByLeadId: null,
          requestedById: req.user.id,
          email: { equals: contact.email, mode: 'insensitive' },
          phone: contact.phone ?? null,
        },
        orderBy: { decidedAt: 'asc' },
        select: { id: true },
      });
      if (!exception) {
        // Tell the form where the approval stands so it can offer the right action.
        const latest = await prisma.duplicateLeadApproval.findFirst({
          where: {
            requestedById: req.user.id,
            email: { equals: contact.email, mode: 'insensitive' },
            phone: contact.phone ?? null,
            consumedByLeadId: null,
          },
          orderBy: { createdAt: 'desc' },
          select: { status: true, rejectedReason: true },
        });
        return res.status(400).json({
          message: `This lead already exists (${dupe.leadNumber}).`,
          errors: duplicateErrors(dupe, contact),
          duplicate: {
            leadNumber: dupe.leadNumber,
            approvalStatus: latest?.status ?? 'NONE',
            rejectedReason: latest?.rejectedReason ?? null,
          },
        });
      }
    }

    const distributorId = await resolveDistributorId(req.body?.distributorId);
    const ownerId = await resolveOwnerId(req, req.user.id);

    const lead = await prisma.$transaction(async (tx) => {
      // Spend the approval atomically with the creation — the conditional
      // updateMany means two racing creates can't both use it.
      if (exception) {
        const { count } = await tx.duplicateLeadApproval.updateMany({
          where: { id: exception.id, consumedByLeadId: null },
          data: { consumedByLeadId: 'pending' },
        });
        if (count === 0) {
          const err = new Error('This duplicate approval was already used.');
          err.status = 400;
          throw err;
        }
      }
      const leadNumber = await generateLeadNumber(tx);
      const created = await tx.lead.create({
        data: {
          leadNumber,
          category,
          requirementDetails,
          ...contact,
          distributorId,
          status: 'NEW',
          createdById: req.user.id,
          assignedSalesId: ownerId,
        },
        include: creatorSelect,
      });
      if (exception) {
        await tx.duplicateLeadApproval.update({
          where: { id: exception.id },
          data: { consumedByLeadId: created.id },
        });
      }
      return created;
    });

    await logEvent({
      action: 'LEAD_CREATED',
      entityType: 'Lead',
      entityId: lead.id,
      summary: `Created lead ${lead.leadNumber} — ${lead.organizationName}`,
      actor: actorFromReq(req),
    });
    await addLeadNote({ leadId: lead.id, stage: 'LEAD', body: lead.notes, actor: actorFromReq(req) });

    return res.status(201).json({ message: 'Lead created.', data: lead });
  } catch (error) {
    if (error?.status === 400) return res.status(400).json({ message: error.message });
    console.error('[lead.createLead]', error);
    return res.status(500).json({ message: 'Failed to create lead.' });
  }
};

/** GET /api/leads — search + category/status filters + pagination. */
export const getLeads = async (req, res) => {
  try {
    const { search, category, status } = req.query;
    const term = search ? String(search).trim() : '';

    const where = {
      // Sales users see only the leads they own; admins see every lead.
      ...(isAdmin(req.user) ? {} : { assignedSalesId: req.user.id }),
      ...(category && LEAD_CATEGORIES.includes(category) ? { category } : {}),
      ...(status && VALID_STATUSES.includes(status) ? { status } : {}),
      ...(term
        ? {
            OR: [
              { leadNumber: { contains: term, mode: 'insensitive' } },
              { organizationName: { contains: term, mode: 'insensitive' } },
              { email: { contains: term, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const { page, limit, skip } = parsePagination(req.query);
    const [items, total] = await Promise.all([
      prisma.lead.findMany({
        where,
        include: creatorSelect,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.lead.count({ where }),
    ]);

    return res.json(paginatedResponse({ items: stripLeadsForRole(req.user, items), total, page, limit }));
  } catch (error) {
    console.error('[lead.getLeads]', error);
    return res.status(500).json({ message: 'Failed to fetch leads.' });
  }
};

/** GET /api/leads/:id */
export const getLead = async (req, res) => {
  try {
    const lead = await prisma.lead.findUnique({
      where: { id: req.params.id },
      include: creatorSelect,
    });
    if (!lead) return res.status(404).json({ message: 'Lead not found.' });
    // Sales users may only open their own leads; admins may open any.
    if (!isAdmin(req.user) && lead.assignedSalesId !== req.user.id) {
      return res.status(404).json({ message: 'Lead not found.' });
    }
    return res.json({ data: stripLeadForRole(req.user, lead) });
  } catch (error) {
    console.error('[lead.getLead]', error);
    return res.status(500).json({ message: 'Failed to fetch lead.' });
  }
};

/**
 * PATCH /api/leads/:id/ip-details (SALES owner + admin) — network handover
 * details captured at the docs stage: { irinnEmail, ipv4, ipv6 }.
 */
export const updateIpDetails = async (req, res) => {
  try {
    const lead = await prisma.lead.findUnique({
      where: { id: req.params.id },
      select: { id: true, assignedSalesId: true },
    });
    if (!lead) return res.status(404).json({ message: 'Lead not found.' });
    if (!isAdmin(req.user) && lead.assignedSalesId !== req.user.id) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    const result = validateIpDetails(req.body);
    if (!result.ok) return res.status(400).json({ message: 'Validation failed.', errors: result.errors });

    const updated = await prisma.lead.update({
      where: { id: lead.id },
      data: { ipDetails: result.data ?? prismaPkg.Prisma.DbNull },
      select: { id: true, ipDetails: true },
    });
    await logEvent({
      action: 'IP_DETAILS_UPDATED',
      entityType: 'Lead',
      entityId: lead.id,
      summary: 'Updated IRINN email / IP details',
      actor: actorFromReq(req),
    });
    return res.json({ message: 'Network details saved.', data: updated });
  } catch (error) {
    console.error('[lead.updateIpDetails]', error);
    return res.status(500).json({ message: 'Failed to save network details.' });
  }
};

/** PUT /api/leads/:id — update contact + requirementDetails (re-validated). */
export const updateLead = async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.lead.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ message: 'Lead not found.' });
    // Owner-scoped like getLead: sales users may only edit their own leads
    // (404, never revealing existence); admins may edit any.
    if (!isAdmin(req.user) && existing.assignedSalesId !== req.user.id) {
      return res.status(404).json({ message: 'Lead not found.' });
    }

    const result = validateLeadPayload(req.body);
    if (!result.ok) {
      return res.status(400).json({ message: 'Validation failed.', errors: result.errors });
    }
    const { category, requirementDetails, ...contact } = result.data;

    // Editing must not clone another lead's contact identity (self excluded).
    const dupe = await findDuplicateLead(contact, id);
    if (dupe) {
      return res.status(400).json({
        message: `Another lead already uses these contact details (${dupe.leadNumber}).`,
        errors: duplicateErrors(dupe, contact),
      });
    }

    const distributorId = await resolveDistributorId(req.body?.distributorId ?? existing.distributorId);
    // Admins may reassign the owner while editing; others keep the current owner.
    const ownerId = await resolveOwnerId(req, existing.assignedSalesId);

    const lead = await prisma.lead.update({
      where: { id },
      data: { category, requirementDetails, ...contact, distributorId, assignedSalesId: ownerId },
      include: creatorSelect,
    });

    const changes = diffFields(existing, lead, LEAD_DIFF_FIELDS);
    if (changes.length) {
      const fieldNames = changes.map((c) => c.field).join(', ');
      await logEvent({
        action: 'LEAD_UPDATED',
        entityType: 'Lead',
        entityId: id,
        summary: `Updated lead ${lead.leadNumber} (${fieldNames})`,
        changes,
        actor: actorFromReq(req),
      });
    }
    return res.json({ message: 'Lead updated.', data: lead });
  } catch (error) {
    if (error?.status === 400) return res.status(400).json({ message: error.message });
    console.error('[lead.updateLead]', error);
    return res.status(500).json({ message: 'Failed to update lead.' });
  }
};
