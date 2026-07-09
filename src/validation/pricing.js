import { z } from 'zod';

// Pricing captures the monthly rate, an optional discount %, and free-text
// notes. Location (lat/long) and POP are set earlier during feasibility review.
// finalPrice is always recomputed here from rate + discount — never trusted
// from the client. Stray keys are ignored by zod.
const pricingSchema = z.object({
  ratePerMonth: z.coerce.number().positive('Rate must be greater than 0.'),
  discountPercentage: z.preprocess(
    (v) => (v === '' || v == null ? 0 : v),
    z.coerce
      .number()
      .min(0, 'Discount % must be between 0 and 100.')
      .max(100, 'Discount % must be between 0 and 100.'),
  ),
  notes: z.preprocess((v) => {
    if (typeof v !== 'string') return v;
    const t = v.trim();
    return t === '' ? undefined : t;
  }, z.string().max(1000).optional()),
});

// Notes-only schema for the ISP component path (rate comes from the sum).
const notesSchema = pricingSchema.pick({ notes: true });

/**
 * Validate a pricing payload. For ISP leads pass the lead's `bandwidthMix`:
 * pricing then takes one positive amount per selected requirement
 * (`components`), and ratePerMonth/finalPrice are the SUM — never trusted
 * from the client. Non-ISP keeps the single rate − discount% shape.
 */
export const validatePricing = (body = {}, bandwidthMix = null) => {
  if (Array.isArray(bandwidthMix) && bandwidthMix.length > 0) {
    const errors = [];
    const components = {};
    for (const type of bandwidthMix) {
      const raw = body?.components?.[type];
      const n = Number(raw);
      if (raw === undefined || raw === null || raw === '' || !Number.isFinite(n) || n <= 0) {
        errors.push({ path: `components.${type}`, message: `Enter a monthly price for ${type.replace(/_/g, ' ')}.` });
      } else {
        components[type] = Math.round(n * 100) / 100;
      }
    }
    const noteResult = notesSchema.safeParse(body);
    if (!noteResult.success) {
      errors.push(...noteResult.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    }
    if (errors.length) return { ok: false, errors };
    const total = Math.round(Object.values(components).reduce((s, v) => s + v, 0) * 100) / 100;
    return {
      ok: true,
      data: {
        components,
        ratePerMonth: total,
        discountPercentage: 0, // ISP deals carry no discount
        finalPrice: total,
        ...(noteResult.data.notes ? { notes: noteResult.data.notes } : {}),
      },
    };
  }

  const result = pricingSchema.safeParse(body);
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    };
  }
  const { ratePerMonth, discountPercentage, notes } = result.data;
  const finalPrice = Math.round(ratePerMonth * (1 - discountPercentage / 100) * 100) / 100;
  return {
    ok: true,
    data: { ratePerMonth, discountPercentage, finalPrice, ...(notes ? { notes } : {}) },
  };
};
