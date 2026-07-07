import { z } from 'zod';

const blankToUndef = (v) => {
  if (typeof v === 'string') {
    const t = v.trim();
    return t === '' ? undefined : t;
  }
  return v ?? undefined;
};
const optStr = z.preprocess(blankToUndef, z.string().max(500).optional());
const optId = z.preprocess(blankToUndef, z.string().uuid('Invalid id.').optional());
const optPrice = z.preprocess(
  (v) => (v === '' || v == null ? undefined : v),
  z.coerce.number().min(0).optional(),
);

const poItemSchema = z.object({
  productId: z.string().uuid('A valid product is required.'),
  quantity: z.coerce.number().int().positive('Quantity must be a positive whole number.'),
  unitPrice: optPrice,
});

const poSchema = z.object({
  vendorId: optId,
  notes: optStr,
  remark: optStr,
  warehouse: optStr,
  items: z.array(poItemSchema).min(1, 'Add at least one item to the purchase order.'),
});

export const validatePurchaseOrder = (body = {}) => {
  const result = poSchema.safeParse(body);
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    };
  }
  return { ok: true, data: result.data };
};

// Add-to-inventory payload: per PO item, either serials (serialized) or a
// received quantity (bulk). The controller picks the right one per product unit.
const addItemSchema = z.object({
  poItemId: z.string().uuid('A valid PO item is required.'),
  serialNumbers: z.array(z.string().trim().min(1)).optional(),
  receivedQuantity: z.preprocess(
    (v) => (v === '' || v == null ? undefined : v),
    z.coerce.number().int().positive().optional(),
  ),
});

const addToInventorySchema = z.object({
  items: z.array(addItemSchema).min(1, 'Provide at least one item to stock.'),
});

export const validateAddToInventory = (body = {}) => {
  const result = addToInventorySchema.safeParse(body);
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    };
  }
  return { ok: true, data: result.data };
};
