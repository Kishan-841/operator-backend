import { z } from 'zod';

const flatten = (error) =>
  error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));

// Catalog-driven material request (store-inventory-flow): each item references
// a StoreProduct by id with a requested quantity.
const materialReqSchema = z.object({
  items: z
    .array(
      z.object({
        productId: z.string().uuid('A valid product is required.'),
        quantity: z.coerce.number().int().positive('Quantity must be a positive whole number.'),
      }),
    )
    .min(1, 'Add at least one product.'),
  deliveryAddress: z.string().max(500).optional().nullable(),
  urgency: z.string().max(50).optional().nullable(),
  notes: z.string().optional().nullable(),
});

const dispatchSchema = z.object({
  items: z
    .array(
      z.object({
        name: z.string().min(1),
        quantity: z.coerce.number().int().positive(),
        serials: z.array(z.string()).optional().default([]),
      }),
    )
    .min(1, 'At least one item is required.'),
  notes: z.string().optional().nullable(),
});

export const validateMaterialReq = (body = {}) => {
  const r = materialReqSchema.safeParse(body);
  return r.success ? { ok: true, data: r.data } : { ok: false, errors: flatten(r.error) };
};

export const validateDispatch = (body = {}) => {
  const r = dispatchSchema.safeParse(body);
  return r.success ? { ok: true, data: r.data } : { ok: false, errors: flatten(r.error) };
};
