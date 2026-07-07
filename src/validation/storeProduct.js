import { z } from 'zod';

export const STORE_PRODUCT_TYPES = [
  'SWITCH',
  'SFP',
  'CLOSURE',
  'RF',
  'PATCH_CORD',
  'FIBER',
  'MEDIA_CONVERTER',
  'ROUTER',
];

const blankToUndef = (v) => {
  if (typeof v === 'string') {
    const t = v.trim();
    return t === '' ? undefined : t;
  }
  return v ?? undefined;
};

const optStr = z.preprocess(blankToUndef, z.string().max(500).optional());
const optPrice = z.preprocess(
  (v) => (v === '' || v == null ? undefined : v),
  z.coerce.number().min(0, 'Price must be 0 or more.').optional(),
);

const productSchema = z.object({
  category: z.enum(STORE_PRODUCT_TYPES, { message: 'A valid product category is required.' }),
  modelNumber: z.string().trim().min(1, 'Model number is required.').max(200),
  brandName: z.string().trim().min(1, 'Brand name is required.').max(200),
  price: optPrice,
  description: optStr,
  // "pcs" (serialized/discrete) or "mtrs" (bulk). Defaults to pcs.
  unit: z.preprocess((v) => blankToUndef(v) ?? 'pcs', z.enum(['pcs', 'mtrs'])),
  isActive: z.boolean().optional(),
});

export const validateStoreProduct = (body = {}) => {
  const result = productSchema.safeParse(body);
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    };
  }
  return { ok: true, data: result.data };
};
