import { z } from 'zod';

const flatten = (error) =>
  error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));

const aggregatorSchema = z.object({
  // BGP is ISP-only — the state machine enforces that per-category rule; this
  // shape check just admits the known types.
  aggregatorType: z.enum(['BNG', 'MIKROTIK', 'BGP']),
  // Optional handoff note — normalise empty/missing to undefined.
  remark: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional().nullable(),
  ),
});

// NOC L3 allocation fields vary by aggregator type (BNG vs MIKROTIK). Accept the
// known keys as trimmed strings; the form enforces which are required per type.
const IP_ALLOC_KEYS = [
  'mikrotikIdentity',
  'mikrotikIp',
  'mikrotikGateway',
  'snatPool',
  'dynamicPool',
  'vlan',
  'loopbackIp',
  'vsi',
  // legacy generic fields, kept for backward compatibility
  'subnet',
  'gateway',
  'vlanId',
];

export const validateAggregator = (body = {}) => {
  const r = aggregatorSchema.safeParse(body);
  return r.success ? { ok: true, data: r.data } : { ok: false, errors: flatten(r.error) };
};

export const validateIpAllocation = (body = {}) => {
  const src = body && typeof body === 'object' ? body : {};
  const data = {};
  for (const k of IP_ALLOC_KEYS) {
    const v = src[k];
    if (typeof v === 'string' && v.trim()) data[k] = v.trim();
    else if (typeof v === 'number' && Number.isFinite(v)) data[k] = String(v);
  }
  if (Object.keys(data).length === 0) {
    return { ok: false, errors: [{ path: 'ipAllocation', message: 'Enter the IP allocation details.' }] };
  }
  return { ok: true, data };
};
