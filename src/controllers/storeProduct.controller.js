import prisma from '../config/db.js';
import { parsePagination, paginatedResponse } from '../utils/pagination.js';
import { validateStoreProduct, STORE_PRODUCT_TYPES } from '../validation/storeProduct.js';
import { logEvent } from '../services/statusChangeLog.service.js';
import { actorFromReq } from '../utils/requestContext.js';

const OPTIONAL_KEYS = ['price', 'description'];

/** GET /api/store/products — search (model/brand) + category filter + pagination. */
export const listProducts = async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const term = req.query.search ? String(req.query.search).trim() : '';
    const category = STORE_PRODUCT_TYPES.includes(req.query.category) ? req.query.category : undefined;
    const where = {
      ...(category ? { category } : {}),
      ...(term
        ? {
            OR: [
              { modelNumber: { contains: term, mode: 'insensitive' } },
              { brandName: { contains: term, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      prisma.storeProduct.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
      prisma.storeProduct.count({ where }),
    ]);
    return res.json(paginatedResponse({ items, total, page, limit }));
  } catch (error) {
    console.error('[storeProduct.list]', error);
    return res.status(500).json({ message: 'Failed to fetch products.' });
  }
};

/** GET /api/store/products/options?q= — active products for the request/PO pickers. */
export const listProductOptions = async (req, res) => {
  try {
    const term = req.query.q ? String(req.query.q).trim() : '';
    const items = await prisma.storeProduct.findMany({
      where: {
        isActive: true,
        ...(term
          ? {
              OR: [
                { modelNumber: { contains: term, mode: 'insensitive' } },
                { brandName: { contains: term, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: { modelNumber: 'asc' },
      take: 50,
      select: { id: true, category: true, modelNumber: true, brandName: true, unit: true },
    });
    return res.json({ items });
  } catch (error) {
    console.error('[storeProduct.options]', error);
    return res.status(500).json({ message: 'Failed to fetch products.' });
  }
};

/** POST /api/store/products (STORE / admin) */
export const createProduct = async (req, res) => {
  try {
    const result = validateStoreProduct(req.body);
    if (!result.ok) return res.status(400).json({ message: 'Validation failed.', errors: result.errors });

    const data = await prisma.storeProduct.create({ data: { ...result.data, createdById: req.user.id } });
    await logEvent({
      action: 'STORE_PRODUCT_CREATED',
      entityType: 'StoreProduct',
      entityId: data.id,
      summary: `Created product "${data.modelNumber}" (${data.category})`,
      actor: actorFromReq(req),
    });
    return res.status(201).json({ message: 'Product created.', data });
  } catch (error) {
    if (error?.code === 'P2002') {
      return res.status(409).json({ message: 'A product with this model number already exists.' });
    }
    console.error('[storeProduct.create]', error);
    return res.status(500).json({ message: 'Failed to create product.' });
  }
};

/** PUT /api/store/products/:id (STORE / admin) */
export const updateProduct = async (req, res) => {
  try {
    const existing = await prisma.storeProduct.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ message: 'Product not found.' });

    const result = validateStoreProduct(req.body);
    if (!result.ok) return res.status(400).json({ message: 'Validation failed.', errors: result.errors });

    const data = { ...result.data };
    for (const k of OPTIONAL_KEYS) if (data[k] === undefined) data[k] = null;

    const updated = await prisma.storeProduct.update({ where: { id: req.params.id }, data });
    return res.json({ message: 'Product updated.', data: updated });
  } catch (error) {
    if (error?.code === 'P2002') {
      return res.status(409).json({ message: 'A product with this model number already exists.' });
    }
    console.error('[storeProduct.update]', error);
    return res.status(500).json({ message: 'Failed to update product.' });
  }
};

/** DELETE /api/store/products/:id (STORE / admin) — blocked if it has stock/history. */
export const deleteProduct = async (req, res) => {
  try {
    const existing = await prisma.storeProduct.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ message: 'Product not found.' });

    // A product referenced by a PO item or a delivery request is part of the
    // record — deactivate it (isActive:false) instead of deleting.
    const [poItems, drItems] = await Promise.all([
      prisma.storePurchaseOrderItem.count({ where: { productId: existing.id } }),
      prisma.deliveryRequestItem.count({ where: { productId: existing.id } }),
    ]);
    if (poItems > 0 || drItems > 0) {
      return res.status(409).json({
        message: 'This product is used by a purchase order or delivery request — deactivate it instead of deleting.',
      });
    }

    await prisma.storeProduct.delete({ where: { id: existing.id } });
    await logEvent({
      action: 'STORE_PRODUCT_DELETED',
      entityType: 'StoreProduct',
      entityId: existing.id,
      summary: `Deleted product "${existing.modelNumber}"`,
      actor: actorFromReq(req),
    });
    return res.json({ message: 'Product deleted.' });
  } catch (error) {
    console.error('[storeProduct.delete]', error);
    return res.status(500).json({ message: 'Failed to delete product.' });
  }
};
