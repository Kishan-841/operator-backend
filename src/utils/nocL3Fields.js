// Server-side mirror of frontend/lib/noc-l3.js — the REQUIRED ipAllocation
// keys per aggregator type. Keep the two files in sync when adding fields.
const BNG_KEYS = ['mikrotikIp', 'mikrotikIdentity', 'loopbackIp', 'vsi', 'subnetMask', 'vlan'];

export const NOC_L3_FIELD_KEYS = {
  MIKROTIK: ['mikrotikIdentity', 'mikrotikIp', 'mikrotikGateway', 'snatPool', 'dynamicPool', 'subnetMask', 'vlan'],
  BNG: BNG_KEYS,
  // BIRAS is a BNG-class aggregator — identical fields, and it likewise makes
  // MIKROTIK configs optional at NOC L3 (see BNG_CLASS below).
  BIRAS: BNG_KEYS,
  BGP: ['bgpLocalIp', 'bgpPeerIp', 'peerAsn', 'advertisedSubnet', 'subnetMask', 'vlan'],
};

// Aggregators that carry the aggregation themselves — when one is selected,
// MIKROTIK sections may be left empty at NOC L3.
export const BNG_CLASS = ['BNG', 'BIRAS'];

// Keys that hold MULTIPLE values (an "Add" list in the form) — stored as a
// cleaned string array. Reads/writes tolerate a legacy single string.
export const MULTI_L3_KEYS = ['snatPool', 'dynamicPool'];

/** Normalize a submitted/stored pool value to a trimmed, non-empty string array. */
export const toPoolList = (v) => {
  const arr = Array.isArray(v) ? v : v == null ? [] : [v];
  return arr.map((x) => String(x ?? '').trim()).filter(Boolean);
};

export const KNOWN_AGGREGATORS = Object.keys(NOC_L3_FIELD_KEYS);

// Custom types (added at stage 10) have no bespoke field set — they use this
// generic one. `notes` is accepted but never required.
export const GENERIC_L3_FIELD_KEYS = ['identity', 'ip', 'gateway', 'subnetMask', 'vlan'];

export const requiredKeysFor = (type) => NOC_L3_FIELD_KEYS[type] || GENERIC_L3_FIELD_KEYS;
export const allowedKeysFor = (type) => NOC_L3_FIELD_KEYS[type] || [...GENERIC_L3_FIELD_KEYS, 'notes'];
