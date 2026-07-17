// Server-side mirror of frontend/lib/noc-l3.js — the REQUIRED ipAllocation
// keys per aggregator type. Keep the two files in sync when adding fields.
const BNG_KEYS = ['mikrotikIp', 'mikrotikIdentity', 'loopbackIp', 'vsi', 'vlan'];

export const NOC_L3_FIELD_KEYS = {
  MIKROTIK: ['mikrotikIdentity', 'mikrotikIp', 'mikrotikGateway', 'snatPool', 'dynamicPool', 'vlan'],
  BNG: BNG_KEYS,
  // BIRAS is a BNG-class aggregator — identical fields, and it likewise makes
  // MIKROTIK configs optional at NOC L3 (see BNG_CLASS below).
  BIRAS: BNG_KEYS,
  BGP: ['bgpLocalIp', 'bgpPeerIp', 'peerAsn', 'advertisedSubnet', 'vlan'],
};

// Aggregators that carry the aggregation themselves — when one is selected,
// MIKROTIK sections may be left empty at NOC L3.
export const BNG_CLASS = ['BNG', 'BIRAS'];

export const KNOWN_AGGREGATORS = Object.keys(NOC_L3_FIELD_KEYS);

// Custom types (added at stage 10) have no bespoke field set — they use this
// generic one. `notes` is accepted but never required.
export const GENERIC_L3_FIELD_KEYS = ['identity', 'ip', 'gateway', 'vlan'];

export const requiredKeysFor = (type) => NOC_L3_FIELD_KEYS[type] || GENERIC_L3_FIELD_KEYS;
export const allowedKeysFor = (type) => NOC_L3_FIELD_KEYS[type] || [...GENERIC_L3_FIELD_KEYS, 'notes'];
