import { z } from 'zod';

/**
 * Lead validation — single Zod source on the backend (mirrored on the frontend
 * in lib/lead-categories.js). Common fields live on the base; category-specific
 * data is validated against `requirementDetails`. (CLAUDE.md §7)
 */

export const LEAD_CATEGORIES = ['PIN_RATE', 'JV', 'REVENUE_SHARING', 'ISP'];
export const BANDWIDTH_MIX = ['MIX_BANDWIDTH', 'PEERING', 'ILL', 'P2P', 'AKAMAI'];

// --- Category-specific requirement shapes ---
// user count + rate render under "Operator details" in the form, but stay in
// requirementDetails here (CLAUDE.md §6 — no per-category columns on Lead).
const pinRate = z.object({
  estimatedUserCount: z.number().int().positive(),
  ratePerUser: z.number().positive(),
});

const bankDetails = z.object({
  accountName: z.string().min(1),
  accountNumber: z.string().min(1),
  ifsc: z.string().min(1),
  bankName: z.string().min(1),
});

const jv = z.object({
  userCount: z.number().int().positive(),
  percentageSplit: z.number().min(0).max(100),
  bankDetails,
});

// Revenue sharing bills either a fixed rate or a percentage split; rateType
// picks which, and only the chosen field is required.
export const REVENUE_RATE_TYPES = ['PERCENTAGE', 'FIXED'];
const revenueSharing = z
  .object({
    userCount: z.number().int().positive(),
    rateType: z.enum(REVENUE_RATE_TYPES),
    percentageSplit: z.number().min(0).max(100).optional().nullable(),
    fixedRate: z.number().positive().optional().nullable(),
    bankDetails,
  })
  .superRefine((val, ctx) => {
    if (val.rateType === 'PERCENTAGE' && (val.percentageSplit === undefined || val.percentageSplit === null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['percentageSplit'], message: 'Required' });
    }
    if (val.rateType === 'FIXED' && (val.fixedRate === undefined || val.fixedRate === null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['fixedRate'], message: 'Required' });
    }
  });

export const BANDWIDTH_UNITS = ['MB', 'GB'];

// Per-selected-type bandwidth amount + unit (mirrors the FE schema). The FE
// pre-validates which specs are required; here we accept the shape and require a
// spec for every selected type.
const coordPair = z.object({
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
});

const isp = z
  .object({
    asNumber: z.number().int().positive().optional().nullable(),
    bandwidthMix: z.array(z.enum(BANDWIDTH_MIX)).min(1),
    bandwidthSpecs: z
      .record(
        z.string(),
        z.object({ value: z.number().positive(), unit: z.enum(BANDWIDTH_UNITS) }),
      )
      .optional()
      .default({}),
    // P2P link endpoints (Point A → Point B).
    p2pLink: z.object({ pointA: coordPair.optional(), pointB: coordPair.optional() }).optional().nullable(),
  })
  .superRefine((val, ctx) => {
    for (const key of val.bandwidthMix || []) {
      if (!val.bandwidthSpecs?.[key]) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['bandwidthSpecs', key], message: 'Bandwidth spec required.' });
      }
    }
  });

const REQUIREMENT_SCHEMAS = { PIN_RATE: pinRate, JV: jv, REVENUE_SHARING: revenueSharing, ISP: isp };

const optStr = z.string().trim().optional().nullable();

// Mobile numbers: required, exactly 10 digits (0-9), no spaces/dashes/country code.
const mobile = z
  .string()
  .trim()
  .min(1, 'Mobile number is required.')
  .regex(/^\d{10}$/, 'Enter exactly 10 digits.');

// Common fields — apply to every category.
const contactBase = z.object({
  category: z.enum(LEAD_CATEGORIES),
  // Operator details
  organizationName: z.string().min(1, 'Organization name is required.'),
  email: z.string().email('A valid email is required.'),
  website: optStr,
  whatsappNumber: mobile,
  existingServiceProvider: optStr,
  annualRevenue: z.number().min(0).optional().nullable(),
  // Contact person
  contactPersonName: optStr,
  phone: mobile,
  gender: optStr,
  // Location
  areaName: optStr,
  city: optStr,
  state: optStr,
  pincode: optStr,
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
  territory: optStr,
  // Lead details
  sourceOfLead: optStr,
  customerInterestLevel: z.enum(['HOT', 'WARM', 'COLD']).optional().nullable(),
  notes: optStr,
});

/**
 * Validate a lead create/update payload. Returns `{ ok: true, data }` or
 * `{ ok: false, errors }` (array of { path, message }) for a 400 response.
 */
// Distributors reuse the lead shape but never enter the pipeline, so the
// prospect-only metrics (estimated user count / existing rate) aren't captured
// for them — see DISTRIBUTOR_REQUIREMENT_SCHEMAS below.
const DISTRIBUTOR_REQUIREMENT_SCHEMAS = {
  ...REQUIREMENT_SCHEMAS,
  PIN_RATE: z.object({}).passthrough(),
};

/**
 * `variant: 'distributor'` relaxes the requirement blob for fields the
 * distributor form doesn't ask for.
 */
export const validateLeadPayload = (body = {}, { variant = 'lead' } = {}) => {
  const base = contactBase.safeParse(body);
  if (!base.success) {
    return { ok: false, errors: flatten(base.error) };
  }

  const schemas = variant === 'distributor' ? DISTRIBUTOR_REQUIREMENT_SCHEMAS : REQUIREMENT_SCHEMAS;
  const reqSchema = schemas[base.data.category];
  const req = reqSchema.safeParse(body.requirementDetails ?? {});
  if (!req.success) {
    return { ok: false, errors: flatten(req.error, 'requirementDetails') };
  }

  return { ok: true, data: { ...base.data, requirementDetails: req.data } };
};

const flatten = (error, prefix) =>
  error.issues.map((i) => ({
    path: [prefix, ...i.path].filter(Boolean).join('.'),
    message: i.message,
  }));
