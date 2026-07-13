import prisma from '../config/db.js';
import { parsePagination, paginatedResponse } from '../utils/pagination.js';
import { validatePurchaseOrder, validateAddToInventory } from '../validation/purchaseOrder.js';
import { generatePurchaseOrderNumber } from '../services/leadNumber.service.js';
import { logEvent } from '../services/statusChangeLog.service.js';
import { refreshSidebarForRoles } from '../services/notification.service.js';
import { actorFromReq } from '../utils/requestContext.js';

const PO_STATUSES = ['PENDING_ADMIN', 'APPROVED', 'REJECTED', 'COMPLETED'];

const poInclude = {
  items: { include: { product: { select: { id: true, modelNumber: true, brandName: true, unit: true, category: true } } } },
  vendor: { select: { id: true, name: true, companyName: true } },
  createdBy: { select: { id: true, name: true } },
  adminApprovedBy: { select: { id: true, name: true } },
};

/** GET /api/store/purchase-orders — status filter + search (poNumber) + pagination. */
export const listPurchaseOrders = async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const term = req.query.search ? String(req.query.search).trim() : '';
    const status = PO_STATUSES.includes(req.query.status) ? req.query.status : undefined;
    const where = {
      ...(status ? { status } : {}),
      ...(term ? { poNumber: { contains: term, mode: 'insensitive' } } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.storePurchaseOrder.findMany({ where, include: poInclude, orderBy: { createdAt: 'desc' }, skip, take: limit }),
      prisma.storePurchaseOrder.count({ where }),
    ]);
    return res.json(paginatedResponse({ items, total, page, limit }));
  } catch (error) {
    console.error('[po.list]', error);
    return res.status(500).json({ message: 'Failed to fetch purchase orders.' });
  }
};

/** GET /api/store/purchase-orders/:id */
export const getPurchaseOrder = async (req, res) => {
  try {
    const po = await prisma.storePurchaseOrder.findUnique({ where: { id: req.params.id }, include: poInclude });
    if (!po) return res.status(404).json({ message: 'Purchase order not found.' });
    return res.json({ data: po });
  } catch (error) {
    console.error('[po.get]', error);
    return res.status(500).json({ message: 'Failed to fetch purchase order.' });
  }
};

/** POST /api/store/purchase-orders (STORE) — create a PENDING_ADMIN PO + items. */
export const createPurchaseOrder = async (req, res) => {
  try {
    const result = validatePurchaseOrder(req.body);
    if (!result.ok) return res.status(400).json({ message: 'Validation failed.', errors: result.errors });
    const { vendorId, notes, remark, warehouse, items } = result.data;

    // Confirm every product exists (FK would 500 otherwise).
    const productIds = [...new Set(items.map((i) => i.productId))];
    const found = await prisma.storeProduct.count({ where: { id: { in: productIds } } });
    if (found !== productIds.length) return res.status(400).json({ message: 'One or more products no longer exist.' });

    const totalAmount = items.reduce((sum, i) => sum + (i.unitPrice ?? 0) * i.quantity, 0) || null;

    const po = await prisma.$transaction(async (tx) => {
      const poNumber = await generatePurchaseOrderNumber(tx);
      return tx.storePurchaseOrder.create({
        data: {
          poNumber,
          vendorId: vendorId ?? null,
          notes: notes ?? null,
          remark: remark ?? null,
          warehouse: warehouse ?? null,
          totalAmount,
          createdById: req.user.id,
          items: {
            create: items.map((i) => ({
              productId: i.productId,
              quantity: i.quantity,
              unitPrice: i.unitPrice ?? null,
              serialNumbers: [],
              status: 'PURCHASED',
            })),
          },
        },
        include: poInclude,
      });
    });

    await logEvent({
      action: 'PO_CREATED',
      entityType: 'StorePurchaseOrder',
      entityId: po.id,
      summary: `Created purchase order ${po.poNumber} (${items.length} item${items.length === 1 ? '' : 's'})`,
      actor: actorFromReq(req),
    });
    await refreshSidebarForRoles(['SUPER_ADMIN', 'ADMIN']); // PO Approvals badge
    return res.status(201).json({ message: 'Purchase order created.', data: po });
  } catch (error) {
    console.error('[po.create]', error);
    return res.status(500).json({ message: 'Failed to create purchase order.' });
  }
};

/** POST /api/store/po-approval/:id/approve (ADMIN) */
export const approvePurchaseOrder = async (req, res) => {
  try {
    const po = await prisma.storePurchaseOrder.findUnique({ where: { id: req.params.id }, select: { id: true, status: true, poNumber: true } });
    if (!po) return res.status(404).json({ message: 'Purchase order not found.' });
    if (po.status !== 'PENDING_ADMIN') {
      return res.status(409).json({ message: 'This purchase order is not awaiting approval. Refresh to see its current state.' });
    }
    const updated = await prisma.storePurchaseOrder.update({
      where: { id: po.id },
      data: { status: 'APPROVED', adminApprovedById: req.user.id, adminApprovedAt: new Date() },
      include: poInclude,
    });
    await logEvent({
      action: 'PO_APPROVED',
      entityType: 'StorePurchaseOrder',
      entityId: po.id,
      summary: `Approved purchase order ${po.poNumber}`,
      actor: actorFromReq(req),
    });
    await refreshSidebarForRoles(['SUPER_ADMIN', 'ADMIN']);
    return res.json({ message: 'Purchase order approved.', data: updated });
  } catch (error) {
    console.error('[po.approve]', error);
    return res.status(500).json({ message: 'Failed to approve purchase order.' });
  }
};

/** POST /api/store/po-approval/:id/reject (ADMIN) { reason } */
export const rejectPurchaseOrder = async (req, res) => {
  try {
    const reason = String(req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ message: 'A reason is required to reject a purchase order.' });
    const po = await prisma.storePurchaseOrder.findUnique({ where: { id: req.params.id }, select: { id: true, status: true, poNumber: true } });
    if (!po) return res.status(404).json({ message: 'Purchase order not found.' });
    if (po.status !== 'PENDING_ADMIN') {
      return res.status(409).json({ message: 'This purchase order is not awaiting approval. Refresh to see its current state.' });
    }
    const updated = await prisma.storePurchaseOrder.update({
      where: { id: po.id },
      data: { status: 'REJECTED', rejectedById: req.user.id, rejectedAt: new Date(), rejectedReason: reason },
      include: poInclude,
    });
    await logEvent({
      action: 'PO_REJECTED',
      entityType: 'StorePurchaseOrder',
      entityId: po.id,
      summary: `Rejected purchase order ${po.poNumber} — ${reason}`,
      actor: actorFromReq(req),
    });
    await refreshSidebarForRoles(['SUPER_ADMIN', 'ADMIN']);
    return res.json({ message: 'Purchase order rejected.', data: updated });
  } catch (error) {
    console.error('[po.reject]', error);
    return res.status(500).json({ message: 'Failed to reject purchase order.' });
  }
};

/** POST /api/store/purchase-orders/:id/add-to-inventory (STORE) — stock the items. */
export const addToInventory = async (req, res) => {
  try {
    const result = validateAddToInventory(req.body);
    if (!result.ok) return res.status(400).json({ message: 'Validation failed.', errors: result.errors });

    const po = await prisma.storePurchaseOrder.findUnique({
      where: { id: req.params.id },
      include: { items: { include: { product: { select: { unit: true, modelNumber: true } } } } },
    });
    if (!po) return res.status(404).json({ message: 'Purchase order not found.' });
    if (po.status !== 'APPROVED') {
      return res.status(409).json({ message: 'Only an approved purchase order can be stocked. Get it approved first.' });
    }

    // Validate each submitted item against its PO item + product unit. Receipts
    // are CUMULATIVE — a partial delivery stocks what arrived and leaves the PO
    // open (APPROVED) until every ordered unit is received.
    const byId = Object.fromEntries(po.items.map((it) => [it.id, it]));
    const writes = [];
    for (const sub of result.data.items) {
      const poItem = byId[sub.poItemId];
      if (!poItem) return res.status(400).json({ message: 'An item does not belong to this purchase order.' });
      const isBulk = poItem.product.unit === 'mtrs';
      const already = poItem.stockedQuantity ?? 0;
      const remaining = poItem.quantity - already;
      if (remaining <= 0) {
        return res.status(400).json({ message: `${poItem.product.modelNumber} is already fully received.` });
      }
      if (isBulk) {
        if (!sub.receivedQuantity) {
          return res.status(400).json({ message: 'Enter the received quantity for the bulk item.' });
        }
        if (sub.receivedQuantity > remaining) {
          return res.status(400).json({
            message: `Only ${remaining} of ${poItem.quantity} m remain to be received for ${poItem.product.modelNumber}.`,
          });
        }
        writes.push({
          id: poItem.id,
          serialNumbers: poItem.serialNumbers,
          receivedQuantity: (poItem.receivedQuantity ?? 0) + sub.receivedQuantity,
          stockedQuantity: already + sub.receivedQuantity,
          addedToStoreAt: poItem.addedToStoreAt,
        });
      } else {
        const serials = [...new Set((sub.serialNumbers || []).map((s) => s.trim()).filter(Boolean))];
        if (serials.length === 0) {
          return res.status(400).json({ message: 'Enter at least one serial number for the serialized item.' });
        }
        const dupes = serials.filter((s) => poItem.serialNumbers.includes(s));
        if (dupes.length) {
          return res.status(400).json({
            message: `Already received on this item: ${dupes.join(', ')}. Remove the duplicate serial${dupes.length === 1 ? '' : 's'}.`,
          });
        }
        if (serials.length > remaining) {
          return res.status(400).json({
            message: `Only ${remaining} of ${poItem.quantity} unit${remaining === 1 ? '' : 's'} remain to be received for ${poItem.product.modelNumber} — you entered ${serials.length} serials.`,
          });
        }
        writes.push({
          id: poItem.id,
          serialNumbers: [...poItem.serialNumbers, ...serials],
          receivedQuantity: (poItem.receivedQuantity ?? 0) + serials.length,
          stockedQuantity: already + serials.length,
          addedToStoreAt: poItem.addedToStoreAt,
        });
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      const now = new Date();
      for (const w of writes) {
        await tx.storePurchaseOrderItem.update({
          where: { id: w.id },
          data: {
            serialNumbers: w.serialNumbers,
            receivedQuantity: w.receivedQuantity,
            stockedQuantity: w.stockedQuantity,
            status: 'IN_STORE', // any stock at all is assignable
            addedToStoreAt: w.addedToStoreAt ?? now, // keep the first receipt's timestamp
          },
        });
      }
      // PO is COMPLETED only once every item is FULLY received.
      const items = await tx.storePurchaseOrderItem.findMany({
        where: { poId: po.id },
        select: { quantity: true, stockedQuantity: true },
      });
      if (items.every((it) => (it.stockedQuantity ?? 0) >= it.quantity)) {
        await tx.storePurchaseOrder.update({ where: { id: po.id }, data: { status: 'COMPLETED' } });
      }
      return tx.storePurchaseOrder.findUnique({ where: { id: po.id }, include: poInclude });
    });

    await logEvent({
      action: 'PO_STOCKED',
      entityType: 'StorePurchaseOrder',
      entityId: po.id,
      summary: `Stocked ${writes.length} item${writes.length === 1 ? '' : 's'} from ${po.poNumber}`,
      actor: actorFromReq(req),
    });
    return res.json({ message: 'Items added to inventory.', data: updated });
  } catch (error) {
    console.error('[po.addToInventory]', error);
    return res.status(500).json({ message: 'Failed to add items to inventory.' });
  }
};

/**
 * GET /api/store/inventory — whole-store availability, grouped per product:
 * live serial numbers (serialized) or metres left (bulk), with per-PO sources.
 * Backs the "Available Material" page.
 */
export const storeInventory = async (req, res) => {
  try {
    const rows = await prisma.storePurchaseOrderItem.findMany({
      where: { status: 'IN_STORE' },
      select: {
        serialNumbers: true,
        receivedQuantity: true,
        product: { select: { id: true, modelNumber: true, brandName: true, category: true, unit: true } },
        purchaseOrder: { select: { poNumber: true } },
      },
      orderBy: { addedToStoreAt: 'asc' },
    });
    const byProduct = new Map();
    for (const row of rows) {
      const isBulk = row.product.unit === 'mtrs';
      const count = isBulk ? (row.receivedQuantity ?? 0) : row.serialNumbers.length;
      if (count <= 0) continue; // drained — nothing left to show
      const g = byProduct.get(row.product.id) || {
        product: row.product,
        available: 0,
        serialNumbers: [],
        sources: [],
      };
      g.available += count;
      g.serialNumbers.push(...(isBulk ? [] : row.serialNumbers));
      g.sources.push({ poNumber: row.purchaseOrder?.poNumber ?? '—', count });
      byProduct.set(row.product.id, g);
    }
    return res.json({ items: [...byProduct.values()] });
  } catch (error) {
    console.error('[po.storeInventory]', error);
    return res.status(500).json({ message: 'Failed to fetch inventory.' });
  }
};

/** GET /api/store/available-inventory?productId= — IN_STORE PO items with stock left. */
export const availableInventory = async (req, res) => {
  try {
    const productId = String(req.query.productId || '').trim();
    if (!productId) return res.status(400).json({ message: 'A productId is required.' });
    const items = await prisma.storePurchaseOrderItem.findMany({
      where: { productId, status: 'IN_STORE' },
      select: {
        id: true,
        productId: true,
        serialNumbers: true,
        receivedQuantity: true,
        purchaseOrder: { select: { id: true, poNumber: true } },
        product: { select: { unit: true, modelNumber: true } },
      },
      orderBy: { addedToStoreAt: 'asc' },
    });
    // Hide drained rows (0 serials / 0 qty) — pure noise in the picker.
    const withStock = items.filter((it) =>
      it.product.unit === 'mtrs' ? (it.receivedQuantity ?? 0) > 0 : it.serialNumbers.length > 0,
    );
    return res.json({ items: withStock });
  } catch (error) {
    console.error('[po.availableInventory]', error);
    return res.status(500).json({ message: 'Failed to fetch inventory.' });
  }
};
