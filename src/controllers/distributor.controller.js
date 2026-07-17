import prisma from '../config/db.js';
import { parsePagination, paginatedResponse } from '../utils/pagination.js';
import { validateLeadPayload } from '../validation/leadCategories.js';
import { logEvent } from '../services/statusChangeLog.service.js';
import { actorFromReq } from '../utils/requestContext.js';

/**
 * Distributors head one or more franchises (leads). GAZON is the seeded
 * default: leads without an explicit distributor belong to it — including
 * pre-existing rows where distributorId is still null.
 */

// Stable key for the transaction-scoped advisory lock that serializes the
// first-ever default-distributor seed (arbitrary constant, shared by all callers).
const DEFAULT_DISTRIBUTOR_LOCK = 428931001;

/** Idempotently ensure the default distributor exists; returns it. */
export const ensureDefaultDistributor = async () => {
  // Fast path — a default already exists, no locking needed.
  const existing = await prisma.distributor.findFirst({ where: { isDefault: true } });
  if (existing) return existing;
  // First-seed path: serialize concurrent callers with a Postgres advisory lock
  // so two requests on a fresh DB can't both create a default row.
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${DEFAULT_DISTRIBUTOR_LOCK})`;
    const again = await tx.distributor.findFirst({ where: { isDefault: true } });
    if (again) return again;
    return tx.distributor.create({ data: { name: 'GAZON', isDefault: true } });
  });
};

// GAZON's leads = its own id ∪ null (legacy rows predating distributors).
const leadScopeFor = (dist) =>
  dist.isDefault ? { OR: [{ distributorId: dist.id }, { distributorId: null }] } : { distributorId: dist.id };

/**
 * Two accepted body shapes:
 *  - FULL operator profile (same fields as a lead, `organizationName` present)
 *    → validated by the lead validator, stored in `profile`, with
 *    name/phone/email extracted for the list + duplicate rules.
 *  - Legacy minimal `{ name, phone?, email? }` (used for GAZON's contact edit).
 * Returns { ok, data?, errors?/message? }.
 */
const normalize = (body = {}) => {
  if (body.organizationName !== undefined) {
    const result = validateLeadPayload(body, { variant: 'distributor' });
    if (!result.ok) return { ok: false, errors: result.errors };
    const { distributorId: _ignored, ...profile } = result.data;
    return {
      ok: true,
      data: {
        name: profile.organizationName,
        phone: profile.phone || null,
        email: String(profile.email || '').trim().toLowerCase() || null,
        profile,
      },
    };
  }
  const name = String(body.name || '').trim();
  if (!name) return { ok: false, message: 'Distributor name is required.' };
  return {
    ok: true,
    data: {
      name,
      phone: String(body.phone || '').trim() || null,
      email: String(body.email || '').trim().toLowerCase() || null,
    },
  };
};

/** Another distributor already using this mobile/email (self excluded). */
const findClash = async ({ phone, email }, excludeId) => {
  const or = [];
  if (phone) or.push({ phone });
  if (email) or.push({ email: { equals: email, mode: 'insensitive' } });
  if (!or.length) return null;
  return prisma.distributor.findFirst({
    where: { OR: or, ...(excludeId ? { NOT: { id: excludeId } } : {}) },
    select: { name: true },
  });
};

/** GET /api/distributors (ADMIN) — every distributor with its franchise count. */
export const listDistributors = async (req, res) => {
  try {
    await ensureDefaultDistributor();
    const items = await prisma.distributor.findMany({ orderBy: [{ isDefault: 'desc' }, { name: 'asc' }] });
    const counts = await prisma.lead.groupBy({ by: ['distributorId'], _count: { _all: true } });
    const byId = Object.fromEntries(counts.map((c) => [c.distributorId ?? 'null', c._count._all]));
    return res.json({
      items: items.map((d) => ({
        ...d,
        franchiseCount: (byId[d.id] || 0) + (d.isDefault ? byId.null || 0 : 0),
      })),
    });
  } catch (error) {
    console.error('[distributor.list]', error);
    return res.status(500).json({ message: 'Failed to fetch distributors.' });
  }
};

/** GET /api/distributors/options — picker list for the lead form (any authenticated). */
export const distributorOptions = async (req, res) => {
  try {
    await ensureDefaultDistributor();
    const items = await prisma.distributor.findMany({
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      select: { id: true, name: true, isDefault: true },
    });
    return res.json({ items });
  } catch (error) {
    console.error('[distributor.options]', error);
    return res.status(500).json({ message: 'Failed to fetch distributors.' });
  }
};

/** POST /api/distributors (ADMIN) { name, phone?, email? } */
export const createDistributor = async (req, res) => {
  try {
    const result = normalize(req.body);
    if (!result.ok) {
      return res.status(400).json({ message: result.message || 'Validation failed.', errors: result.errors });
    }
    const data = result.data;
    const clash = await findClash(data);
    if (clash) {
      return res.status(400).json({ message: `Distributor "${clash.name}" already uses these contact details.` });
    }
    // isDefault is not API-settable — the default was set up once and stays.
    const created = await prisma.distributor.create({ data });
    await logEvent({
      action: 'DISTRIBUTOR_CREATED',
      entityType: 'Distributor',
      entityId: created.id,
      summary: `Created distributor ${created.name}`,
      actor: actorFromReq(req),
    });
    return res.status(201).json({ message: 'Distributor created.', data: created });
  } catch (error) {
    console.error('[distributor.create]', error);
    return res.status(500).json({ message: 'Failed to create distributor.' });
  }
};

/** PUT /api/distributors/:id (ADMIN) { name, phone?, email? } */
export const updateDistributor = async (req, res) => {
  try {
    const dist = await prisma.distributor.findUnique({ where: { id: req.params.id } });
    if (!dist) return res.status(404).json({ message: 'Distributor not found.' });
    const result = normalize(req.body);
    if (!result.ok) {
      return res.status(400).json({ message: result.message || 'Validation failed.', errors: result.errors });
    }
    const data = result.data;
    const clash = await findClash(data, dist.id);
    if (clash) {
      return res.status(400).json({ message: `Distributor "${clash.name}" already uses these contact details.` });
    }
    // isDefault is not API-settable — `data` never carries it, so the flag
    // survives edits untouched.
    const updated = await prisma.distributor.update({ where: { id: dist.id }, data });
    await logEvent({
      action: 'DISTRIBUTOR_UPDATED',
      entityType: 'Distributor',
      entityId: dist.id,
      summary: `Updated distributor ${updated.name}`,
      actor: actorFromReq(req),
    });
    return res.json({ message: 'Distributor updated.', data: updated });
  } catch (error) {
    console.error('[distributor.update]', error);
    return res.status(500).json({ message: 'Failed to update distributor.' });
  }
};

/** DELETE /api/distributors/:id (ADMIN) — franchises fall back to GAZON. */
export const deleteDistributor = async (req, res) => {
  try {
    const dist = await prisma.distributor.findUnique({ where: { id: req.params.id } });
    if (!dist) return res.status(404).json({ message: 'Distributor not found.' });
    if (dist.isDefault) {
      return res.status(400).json({ message: 'The default distributor cannot be deleted — make another distributor the default first.' });
    }
    const gazon = await ensureDefaultDistributor();
    const moved = await prisma.$transaction(async (tx) => {
      const { count } = await tx.lead.updateMany({
        where: { distributorId: dist.id },
        data: { distributorId: gazon.id },
      });
      await tx.distributor.delete({ where: { id: dist.id } });
      return count;
    });
    await logEvent({
      action: 'DISTRIBUTOR_DELETED',
      entityType: 'Distributor',
      entityId: dist.id,
      summary: `Deleted distributor ${dist.name} (${moved} franchise${moved === 1 ? '' : 's'} moved to GAZON)`,
      actor: actorFromReq(req),
    });
    return res.json({ message: `Distributor deleted — ${moved} franchise${moved === 1 ? '' : 's'} moved to GAZON.` });
  } catch (error) {
    console.error('[distributor.delete]', error);
    return res.status(500).json({ message: 'Failed to delete distributor.' });
  }
};

/** GET /api/distributors/:id/leads (ADMIN) — the distributor's franchises. */
export const distributorLeads = async (req, res) => {
  try {
    const dist = await prisma.distributor.findUnique({ where: { id: req.params.id } });
    if (!dist) return res.status(404).json({ message: 'Distributor not found.' });
    const where = leadScopeFor(dist);
    const { page, limit, skip } = parsePagination(req.query);
    const [items, total] = await Promise.all([
      prisma.lead.findMany({
        where,
        select: { id: true, leadNumber: true, organizationName: true, category: true, status: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.lead.count({ where }),
    ]);
    return res.json(paginatedResponse({ items, total, page, limit }));
  } catch (error) {
    console.error('[distributor.leads]', error);
    return res.status(500).json({ message: 'Failed to fetch the distributor’s franchises.' });
  }
};
