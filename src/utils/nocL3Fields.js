// Server-side mirror of frontend/lib/noc-l3.js — the REQUIRED ipAllocation
// keys per aggregator type. Keep the two files in sync when adding fields.
export const NOC_L3_FIELD_KEYS = {
  MIKROTIK: ['mikrotikIdentity', 'mikrotikIp', 'mikrotikGateway', 'snatPool', 'dynamicPool', 'vlan'],
  BNG: ['mikrotikIp', 'mikrotikIdentity', 'loopbackIp', 'vsi'],
  BGP: ['bgpLocalIp', 'bgpPeerIp', 'peerAsn', 'advertisedSubnet', 'vlan'],
};

export const KNOWN_AGGREGATORS = Object.keys(NOC_L3_FIELD_KEYS);
