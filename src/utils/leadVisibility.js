import { isAdmin } from './roleHelper.js';

/**
 * Field-level lead visibility per role (server-side enforcement — the drawer
 * only renders what the API ships). Complements utils/leadAccess.js, which
 * decides WHICH leads a role can open; this decides WHAT of a lead they see.
 *
 * Anything not listed in a group below (leadNumber, organizationName,
 * category, status, timestamps, createdBy…) is identity/stage data visible to
 * every role that can access the lead. Admins are never stripped.
 */

const S = 'SALES_USER';
const F = 'FEASIBILITY_USER';
const D = 'DELIVERY_USER';
const ST = 'STORE_USER';
const L2 = 'NOC_L2_USER';
const L3 = 'NOC_L3_USER';
const SW = 'SOFTWARE_USER';

// field group → roles allowed to see it (approved visibility matrix).
const GROUPS = [
  { fields: ['contactPersonName', 'phone', 'whatsappNumber', 'website', 'gender'], roles: [S, F, D, SW] },
  {
    fields: ['areaName', 'city', 'state', 'pincode', 'latitude', 'longitude', 'territory', 'popLocationId', 'popLocation'],
    roles: [S, F, D, ST, L2, L3],
  },
  { fields: ['email', 'existingServiceProvider', 'annualRevenue'], roles: [S, F, L2, L3, SW] },
  { fields: ['sourceOfLead', 'customerInterestLevel', 'notes'], roles: [S, F] },
  // Rates are visible to sales, software and admins only.
  { fields: ['pricing'], roles: [S, SW] },
  {
    fields: ['approvalNotes', 'pricingRevisionReason', 'pricingRevisionCount', 'approvedById', 'approvedAt', 'approvedBy'],
    roles: [S],
  },
  {
    fields: [
      'feasibilityNotes', 'feasibilityNetworkType', 'feasibilityPops', 'feasibilityOffNet',
      'feasibilityVendors', 'feasibilityReviewedAt', 'feasibilityAssignedToId', 'feasibilityAssignedTo',
    ],
    roles: [S, F, D, L2, L3],
  },
  { fields: ['documents', 'docsRevisionReason', 'docsRevisionCount'], roles: [S, SW] },
  { fields: ['materialReq', 'deliveryRequest'], roles: [S, D, ST] },
  { fields: ['dispatch'], roles: [S, D, ST, L2, L3] },
  { fields: ['installationCompletedAt'], roles: [S, D, L2, L3] },
  { fields: ['ipDetails'], roles: [S, L2, L3, SW] },
  { fields: ['nocL2ConfigNotes', 'nocL2Config', 'nocL2AssignedToId', 'nocL2AssignedTo'], roles: [L2, L3] },
  { fields: ['aggregatorType', 'aggregatorTypes', 'aggregatorSelections', 'aggregatorConfirmRemark'], roles: [S, L2, L3, SW] },
  {
    fields: ['portalManagedBy', 'portalUrl', 'portalUsername', 'portalPassword', 'ipPoolNoticeAt', 'softwareAssignedToId', 'softwareAssignedTo'],
    roles: [S, SW],
  },
  { fields: ['ipAllocation', 'bngConfigDoneAt', 'nocL3AssignedToId', 'nocL3AssignedTo'], roles: [L2, L3] },
  {
    fields: [
      'l3ToL2AssignedToId', 'l3ToL2AssignedTo', 'agreementGeneratedAt', 'agreementSentForSignatureAt',
      'agreementSentForSignatureById', 'agreementUploadedAt', 'agreementVerifiedById', 'agreementVerifiedBy',
    ],
    roles: [S, L2, L3, SW],
  },
];

// requirementDetails is a mixed bag: sizing/technical keys are broadly useful,
// commercial keys (rates, splits, bank account) are sales/admin only.
const REQ_COMMERCIAL_KEYS = ['bankDetails', 'ratePerUser', 'percentageSplit', 'fixedRate', 'rateType'];
// Rate keys (money terms, not bank identity) — visible to software too.
const REQ_RATE_KEYS = ['ratePerUser', 'percentageSplit', 'fixedRate', 'rateType'];
const REQ_ACCESS = {
  [S]: 'full',
  [F]: 'sizing',
  [D]: 'sizing',
  [L2]: 'sizing',
  [L3]: 'sizing',
  [SW]: 'rates', // software needs the AS number + the rates (agreement stage)
  [ST]: 'none',
};

const stripRequirement = (details, access) => {
  if (!details || typeof details !== 'object') return details;
  if (access === 'full') return details;
  if (access === 'as-number') return details.asNumber != null ? { asNumber: details.asNumber } : undefined;
  if (access === 'rates') {
    const kept = {};
    if (details.asNumber != null) kept.asNumber = details.asNumber;
    for (const k of REQ_RATE_KEYS) {
      if (details[k] !== undefined) kept[k] = details[k];
    }
    return Object.keys(kept).length ? kept : undefined;
  }
  if (access === 'sizing') {
    const copy = { ...details };
    for (const k of REQ_COMMERCIAL_KEYS) delete copy[k];
    return copy;
  }
  return undefined; // 'none'
};

/**
 * Return a copy of `lead` with the fields this user's role may not see
 * removed (keys deleted, so the frontend can distinguish "hidden" from
 * "empty"). Admins get the object untouched.
 */
export const stripLeadForRole = (user, lead) => {
  if (!lead || isAdmin(user)) return lead;
  const role = user?.role;
  const copy = { ...lead };
  for (const g of GROUPS) {
    if (g.roles.includes(role)) continue;
    for (const f of g.fields) delete copy[f];
  }
  if ('requirementDetails' in copy) {
    const stripped = stripRequirement(copy.requirementDetails, REQ_ACCESS[role] ?? 'none');
    if (stripped === undefined) delete copy.requirementDetails;
    else copy.requirementDetails = stripped;
  }
  return copy;
};

export const stripLeadsForRole = (user, leads) => leads.map((l) => stripLeadForRole(user, l));

/**
 * Which note-timeline stages each role may read. Sales owners and admins see
 * the full timeline (enforced by the callers); stage roles see the stages
 * they work in plus basic lead context.
 */
export const ROLE_NOTE_STAGES = {
  [F]: ['LEAD', 'FEASIBILITY'],
  [D]: ['LEAD', 'DELIVERY', 'STORE', 'DISPATCH', 'INSTALLATION'],
  [ST]: ['DELIVERY', 'STORE', 'DISPATCH'],
  [L2]: ['INSTALLATION', 'NOC_L2', 'NOC_L3', 'AGGREGATOR', 'L3_TO_L2'],
  [L3]: ['INSTALLATION', 'NOC_L2', 'NOC_L3', 'AGGREGATOR', 'L3_TO_L2'],
  [SW]: ['DOCS', 'SOFTWARE', 'AGREEMENT'],
};
