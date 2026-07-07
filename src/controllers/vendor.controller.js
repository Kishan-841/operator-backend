import prisma from '../config/db.js';
import { parsePagination, paginatedResponse } from '../utils/pagination.js';
import { validateVendor } from '../validation/vendor.js';
import { logEvent } from '../services/statusChangeLog.service.js';
import { actorFromReq } from '../utils/requestContext.js';

const VENDOR_TYPES = ['FIBER', 'CLIENT', 'COMMISSION', 'TELCO'];
// Optional fields that an edit may clear: undefined (omitted) → null on update.
const OPTIONAL_KEYS = ['companyName', 'email', 'mobile', 'gst', 'pan', 'commissionPercentage', 'bankDetails'];

/** GET /api/vendors — search (name/company/email) + type filter + pagination. */
export const listVendors = async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const term = req.query.search ? String(req.query.search).trim() : '';
    const type = VENDOR_TYPES.includes(req.query.type) ? req.query.type : undefined;
    const where = {
      ...(type ? { type } : {}),
      ...(term
        ? {
            OR: [
              { name: { contains: term, mode: 'insensitive' } },
              { companyName: { contains: term, mode: 'insensitive' } },
              { email: { contains: term, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      prisma.vendor.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
      prisma.vendor.count({ where }),
    ]);
    return res.json(paginatedResponse({ items, total, page, limit }));
  } catch (error) {
    console.error('[vendor.list]', error);
    return res.status(500).json({ message: 'Failed to fetch vendors.' });
  }
};

/** GET /api/vendors/options?q= — lightweight list for the feasibility picker. */
export const listVendorOptions = async (req, res) => {
  try {
    const term = req.query.q ? String(req.query.q).trim() : '';
    const items = await prisma.vendor.findMany({
      where: term
        ? {
            OR: [
              { name: { contains: term, mode: 'insensitive' } },
              { companyName: { contains: term, mode: 'insensitive' } },
            ],
          }
        : {},
      orderBy: { name: 'asc' },
      take: 50,
      select: { id: true, name: true, type: true, companyName: true },
    });
    return res.json({ items });
  } catch (error) {
    console.error('[vendor.options]', error);
    return res.status(500).json({ message: 'Failed to fetch vendors.' });
  }
};

/** POST /api/vendors (ADMIN / SALES_USER) */
export const createVendor = async (req, res) => {
  try {
    const result = validateVendor(req.body);
    if (!result.ok) return res.status(400).json({ message: 'Validation failed.', errors: result.errors });

    const data = await prisma.vendor.create({ data: { ...result.data, createdById: req.user.id } });
    await logEvent({
      action: 'VENDOR_CREATED',
      entityType: 'Vendor',
      entityId: data.id,
      summary: `Created vendor "${data.name}" (${data.type})`,
      actor: actorFromReq(req),
    });
    return res.status(201).json({ message: 'Vendor created.', data });
  } catch (error) {
    console.error('[vendor.create]', error);
    return res.status(500).json({ message: 'Failed to create vendor.' });
  }
};

/** PUT /api/vendors/:id (ADMIN / SALES_USER) */
export const updateVendor = async (req, res) => {
  try {
    const existing = await prisma.vendor.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ message: 'Vendor not found.' });

    const result = validateVendor(req.body);
    if (!result.ok) return res.status(400).json({ message: 'Validation failed.', errors: result.errors });

    // Map omitted optionals to null so an edit can clear a previously-set field.
    const data = { ...result.data };
    for (const k of OPTIONAL_KEYS) if (data[k] === undefined) data[k] = null;

    const updated = await prisma.vendor.update({ where: { id: req.params.id }, data });
    return res.json({ message: 'Vendor updated.', data: updated });
  } catch (error) {
    console.error('[vendor.update]', error);
    return res.status(500).json({ message: 'Failed to update vendor.' });
  }
};

/** DELETE /api/vendors/:id (ADMIN / SALES_USER) */
export const deleteVendor = async (req, res) => {
  try {
    const existing = await prisma.vendor.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ message: 'Vendor not found.' });

    await prisma.vendor.delete({ where: { id: req.params.id } });
    await logEvent({
      action: 'VENDOR_DELETED',
      entityType: 'Vendor',
      entityId: existing.id,
      summary: `Deleted vendor "${existing.name}"`,
      actor: actorFromReq(req),
    });
    return res.json({ message: 'Vendor deleted.' });
  } catch (error) {
    console.error('[vendor.delete]', error);
    return res.status(500).json({ message: 'Failed to delete vendor.' });
  }
};
