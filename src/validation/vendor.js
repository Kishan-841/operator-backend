import { z } from 'zod';

// Trim strings; treat blank/null as "not provided" so optional fields don't
// fail format checks and so an empty edit clears the value (controller maps
// undefined → null on update).
const blankToUndef = (v) => {
  if (typeof v === 'string') {
    const t = v.trim();
    return t === '' ? undefined : t;
  }
  return v ?? undefined;
};

const optStr = z.preprocess(blankToUndef, z.string().max(200).optional());
const optEmail = z.preprocess(blankToUndef, z.string().email('A valid email is required.').optional());

// Uppercase + trim, blank → undefined, then enforce a format regex.
const optFormat = (regex, message) =>
  z.preprocess((v) => {
    if (typeof v === 'string') {
      const t = v.trim().toUpperCase();
      return t === '' ? undefined : t;
    }
    return v ?? undefined;
  }, z.string().regex(regex, message).optional());

const optGst = optFormat(
  /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/,
  'Enter a valid 15-character GSTIN (e.g. 22AAAAA0000A1Z5).',
);
const optPan = optFormat(/^[A-Z]{5}\d{4}[A-Z]$/, 'Enter a valid PAN (e.g. ABCDE1234F).');
const optIfsc = optFormat(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Enter a valid IFSC code (e.g. HDFC0001234).');
const optAccountNumber = z.preprocess(
  blankToUndef,
  z.string().regex(/^\d{9,18}$/, 'Account number must be 9–18 digits.').optional(),
);

const optPercent = z.preprocess(
  (v) => (v === '' || v == null ? undefined : v),
  z.coerce
    .number()
    .min(0, 'Commission % must be between 0 and 100.')
    .max(100, 'Commission % must be between 0 and 100.')
    .optional(),
);

const bankDetailsSchema = z
  .object({
    accountName: optStr,
    accountNumber: optAccountNumber,
    ifsc: optIfsc,
    bankName: optStr,
  })
  .optional();

const vendorSchema = z.object({
  type: z.enum(['FIBER', 'CLIENT', 'COMMISSION', 'TELCO'], { message: 'A valid vendor type is required.' }),
  name: z.string().trim().min(1, 'Vendor name is required.').max(200),
  companyName: optStr,
  email: optEmail,
  mobile: optStr,
  gst: optGst,
  pan: optPan,
  commissionPercentage: optPercent,
  bankDetails: bankDetailsSchema,
});

export const validateVendor = (body = {}) => {
  const result = vendorSchema.safeParse(body);
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    };
  }
  const data = result.data;
  // Commission % only applies to COMMISSION vendors — drop it otherwise.
  if (data.type !== 'COMMISSION') data.commissionPercentage = undefined;
  // Collapse an all-blank bankDetails object to undefined.
  if (data.bankDetails && Object.values(data.bankDetails).every((v) => v === undefined)) {
    data.bankDetails = undefined;
  }
  return { ok: true, data };
};
