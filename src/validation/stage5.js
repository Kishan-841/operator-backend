import { allowedKeysFor } from '../utils/nocL3Fields.js';
import { normalizeAggregatorName } from '../utils/aggregators.js';

// Stage-10 body: { selections: [{ type, quantity }], remark? }.
// Legacy generations still accepted: { aggregatorTypes: string[] } and
// { aggregatorType: string } become qty-1 selections. BGP's ISP-only rule is
// the state machine's job; this validates shape, names and quantities.
export const validateAggregator = (body = {}) => {
  let selections = body.selections;
  if (selections === undefined && Array.isArray(body.aggregatorTypes)) {
    selections = body.aggregatorTypes.map((t) => ({ type: t, quantity: 1 }));
  }
  if (selections === undefined && typeof body.aggregatorType === 'string') {
    selections = [{ type: body.aggregatorType, quantity: 1 }];
  }
  if (!Array.isArray(selections) || selections.length === 0) {
    return { ok: false, errors: [{ path: 'selections', message: 'Select at least one aggregator type.' }] };
  }
  // Cap the list — the shared master table is append-only, so an unbounded
  // request must not be able to mass-register names.
  if (selections.length > 10) {
    return { ok: false, errors: [{ path: 'selections', message: 'Select at most 10 aggregator types.' }] };
  }
  const seen = new Set();
  const clean = [];
  for (const s of selections) {
    const type = normalizeAggregatorName(s?.type);
    if (!type) {
      return {
        ok: false,
        errors: [{ path: 'selections.type', message: 'Aggregator names must be 2–30 characters: letters, digits, spaces or dashes.' }],
      };
    }
    const quantity = s?.quantity === undefined ? 1 : s.quantity;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
      return { ok: false, errors: [{ path: 'selections.quantity', message: 'Quantity must be a whole number from 1 to 10.' }] };
    }
    if (seen.has(type)) continue; // dedupe — first occurrence wins
    seen.add(type);
    clean.push({ type, quantity });
  }
  const remark = typeof body.remark === 'string' && body.remark.trim() ? body.remark : undefined;
  return { ok: true, data: { selections: clean, remark } };
};

// Per-aggregator allocation, one entry per UNIT: { MIKROTIK: [{...}, {...}] }.
// Accepts any valid-normalized type name (custom types included); a bare
// object per type (the previous client generation) is wrapped as one unit.
// Strips unknown keys per type; completeness/quantity is enforced in the
// state machine (it knows the lead's selections).
export const validateIpAllocation = (body = {}) => {
  const src = body && typeof body === 'object' ? body : {};
  const data = {};
  for (const [rawType, rawUnits] of Object.entries(src)) {
    const type = normalizeAggregatorName(rawType);
    if (!type) continue;
    const allowed = allowedKeysFor(type);
    const units = Array.isArray(rawUnits) ? rawUnits : [rawUnits];
    const cleanUnits = [];
    for (const unit of units) {
      if (!unit || typeof unit !== 'object') continue;
      const clean = {};
      for (const k of allowed) {
        const v = unit[k];
        if (typeof v === 'string' && v.trim()) clean[k] = v.trim();
        else if (typeof v === 'number' && Number.isFinite(v)) clean[k] = String(v);
      }
      if (Object.keys(clean).length) cleanUnits.push(clean);
    }
    if (cleanUnits.length) data[type] = cleanUnits;
  }
  if (Object.keys(data).length === 0) {
    return { ok: false, errors: [{ path: 'ipAllocation', message: 'Enter the IP allocation details.' }] };
  }
  return { ok: true, data };
};
