// Aggregator type names are user-supplied at stage 10 — normalize before any
// compare/store so 'olt ' and 'OLT' are the same type. Single source for the
// charset rule (mirrored client-side in AggregatorActions).
const NAME_RE = /^[A-Z0-9][A-Z0-9 -]{1,29}$/;

/** trim → UPPERCASE → collapse whitespace; null when invalid. */
export const normalizeAggregatorName = (raw) => {
  const name = String(raw ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
  return NAME_RE.test(name) ? name : null;
};
