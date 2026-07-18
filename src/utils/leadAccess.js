import { isAdmin, hasAccess } from './roleHelper.js';

/**
 * Lead-level access control (object-level authorization).
 *
 *  - Admins: every lead.
 *  - SALES_USER: only leads they own (`assignedSalesId === user.id`).
 *  - Stage roles: only leads currently sitting at one of their stages, i.e. the
 *    work they're actually responsible for. Once a lead moves on, access ends.
 *
 * Statuses each stage role legitimately works / may view a lead at.
 */
export const ROLE_STATUSES = {
  FEASIBILITY_USER: ['FEASIBILITY_PENDING'],
  DELIVERY_USER: ['DELIVERY_REQ_PENDING', 'DISPATCHED', 'INSTALLATION_PENDING'],
  STORE_USER: ['AWAITING_DISPATCH'],
  NOC_L2_USER: ['NOC_L2_PENDING', 'L3_TO_L2_HANDOFF'],
  NOC_L3_USER: ['NOC_L3_PENDING'],
  SOFTWARE_USER: ['DOCS_UPLOADED', 'SOFTWARE_PENDING', 'AGREEMENT_PENDING', 'AGREEMENT_SENT_FOR_SIGNATURE'],
};

/**
 * Can `user` see/act on `lead`? `lead` must carry `assignedSalesId` + `status`.
 * A staff user's reach is the UNION of their accesses: sales access grants their
 * own leads; each stage access grants leads currently at one of that stage's
 * statuses. Holding any one qualifying access is enough.
 */
export const canAccessLead = (user, lead) => {
  if (!user || !lead) return false;
  if (isAdmin(user)) return true;
  const accesses = user.accesses ?? [];
  if (accesses.includes('SALES_USER') && lead.assignedSalesId === user.id) return true;
  return accesses.some((a) => (ROLE_STATUSES[a] ?? []).includes(lead.status));
};

/** Throw a 404 (never reveal existence) when access is denied. */
export const assertLeadAccess = (user, lead) => {
  if (!canAccessLead(user, lead)) {
    const err = new Error('Lead not found.');
    err.status = 404;
    throw err;
  }
};

/**
 * Prisma `where` fragment to scope SALES users to their own leads. Returns `{}`
 * for admins and stage roles (their views are stage-scoped, not owner-scoped),
 * so it's safe to merge into any lead list/count query unconditionally.
 */
export const salesOwnerScope = (user) =>
  !isAdmin(user) && (user?.accesses ?? []).includes('SALES_USER') ? { assignedSalesId: user.id } : {};
