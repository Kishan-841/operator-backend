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

export const validatePricing = (body = {}) => {
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
