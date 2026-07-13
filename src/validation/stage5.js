import { z } from 'zod';
import { NOC_L3_FIELD_KEYS, KNOWN_AGGREGATORS } from '../utils/nocL3Fields.js';

const flatten = (error) =>
  error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));

// Multi-select at stage 10. BGP is ISP-only — the state machine enforces that
// per-category rule; this shape check just admits the known types (single
// source: utils/nocL3Fields.js).
const aggregatorSchema = z.object({
  aggregatorTypes: z.array(z.enum(KNOWN_AGGREGATORS)).min(1, 'Select at least one aggregator type.'),
  // Optional handoff note — normalise empty/missing to undefined.
  remark: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional().nullable(),
  ),
});

export const validateAggregator = (body = {}) => {
  // Legacy clients send a single `aggregatorType` string — wrap it.
  const normalized =
    body.aggregatorTypes === undefined && typeof body.aggregatorType === 'string'
      ? { ...body, aggregatorTypes: [body.aggregatorType] }
      : body;
  const r = aggregatorSchema.safeParse(normalized);
  return r.success ? { ok: true, data: r.data } : { ok: false, errors: flatten(r.error) };
};

// Nested per-aggregator allocation: { BNG: {...}, MIKROTIK: {...} }. Strips
// unknown types and unknown keys; completeness per selected type is enforced
// in the state machine (it knows the lead's selections).
export const validateIpAllocation = (body = {}) => {
  const src = body && typeof body === 'object' ? body : {};
  const data = {};
  for (const type of KNOWN_AGGREGATORS) {
    const section = src[type];
    if (!section || typeof section !== 'object') continue;
    const clean = {};
    for (const k of NOC_L3_FIELD_KEYS[type]) {
      const v = section[k];
      if (typeof v === 'string' && v.trim()) clean[k] = v.trim();
      else if (typeof v === 'number' && Number.isFinite(v)) clean[k] = String(v);
    }
    if (Object.keys(clean).length) data[type] = clean;
  }
  if (Object.keys(data).length === 0) {
    return { ok: false, errors: [{ path: 'ipAllocation', message: 'Enter the IP allocation details.' }] };
  }
  return { ok: true, data };
};
