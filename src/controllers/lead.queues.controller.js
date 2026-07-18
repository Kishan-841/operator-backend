import prisma from '../config/db.js';
import { parsePagination, paginatedResponse } from '../utils/pagination.js';
import { salesOwnerScope } from '../utils/leadAccess.js';
import { stripLeadsForRole } from '../utils/leadVisibility.js';
import { isAdmin } from '../utils/roleHelper.js';

// True when a user should see only handoffs assigned to them: they act as L2
// but lack the broader L3 view and aren't an admin.
const scopeToOwnHandoffs = (user) => {
  const accesses = user?.accesses ?? [];
  return !isAdmin(user) && accesses.includes('NOC_L2_USER') && !accesses.includes('NOC_L3_USER');
};

const withCreator = {
  createdBy: { select: { id: true, name: true } },
  l3ToL2AssignedTo: { select: { id: true, name: true } },
  materialReq: true,
  dispatch: true,
  deliveryRequest: {
    include: {
      items: {
        include: { product: { select: { id: true, modelNumber: true, brandName: true, unit: true, category: true } } },
      },
    },
  },
  documents: {
    select: { id: true, type: true, fileName: true, createdAt: true, verificationStatus: true, salesApprovedAt: true },
    orderBy: { createdAt: 'desc' },
  },
};

// Build a paginated, searchable queue handler for a pipeline status (or a list
// of statuses — e.g. the agreement queue spans pending + sent-for-signature).
// `extraWhere(req)` adds an optional per-request filter (e.g. assigned-to-me).
const queueFor = (status, extraWhere) => async (req, res) => {
  try {
    const term = req.query.search ? String(req.query.search).trim() : '';
    const where = {
      status: Array.isArray(status) ? { in: status } : status,
      ...(extraWhere ? extraWhere(req) : {}),
      ...(term
        ? {
            OR: [
              { leadNumber: { contains: term, mode: 'insensitive' } },
              { organizationName: { contains: term, mode: 'insensitive' } },
              { email: { contains: term, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const { page, limit, skip } = parsePagination(req.query);
    const [items, total] = await Promise.all([
      prisma.lead.findMany({
        where,
        include: withCreator,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.lead.count({ where }),
    ]);
    // Queue rows feed the detail drawer — strip fields the role may not see.
    return res.json(paginatedResponse({ items: stripLeadsForRole(req.user, items), total, page, limit }));
  } catch (error) {
    console.error('[lead.queue]', error);
    return res.status(500).json({ message: 'Failed to fetch queue.' });
  }
};

export const feasibilityQueue = queueFor('FEASIBILITY_PENDING');
// Sales-owned queues are scoped to the acting sales user's leads (admins see all).
export const pricingQueue = queueFor('PRICING_PENDING', (req) => salesOwnerScope(req.user));
export const approvalsQueue = queueFor('PENDING_APPROVAL');
export const docsQueue = queueFor('APPROVED', (req) => salesOwnerScope(req.user));
export const deliveryQueue = queueFor('DELIVERY_REQ_PENDING');
// Stage 6b — admin approval of the material list.
export const materialApprovalQueue = queueFor('MATERIAL_APPROVAL_PENDING');
export const storeQueue = queueFor('AWAITING_DISPATCH');
export const installationQueue = queueFor('DISPATCHED');
export const nocL2Queue = queueFor('NOC_L2_PENDING');
export const aggregatorQueue = queueFor('AGGREGATOR_CONFIRM_PENDING', (req) => salesOwnerScope(req.user));
export const softwareQueue = queueFor('SOFTWARE_PENDING');
// Docs Verify is stage 5b: leads sales has sent for verification (DOCS_UPLOADED).
// The SOFTWARE team approves each uploaded doc before it moves to delivery, so
// the queue is unscoped — software verifies every owner's leads.
export const docsVerifyQueue = queueFor('DOCS_UPLOADED');
export const nocL3Queue = queueFor('NOC_L3_PENDING');
// NOC L2 users see only handoffs assigned to them; NOC L3 + admins see all.
// A staff user acting purely as L2 (has L2 access, not L3, not admin) is scoped;
// anyone with the broader L3 view (or admin) sees every handoff.
export const l3ToL2Queue = queueFor('L3_TO_L2_HANDOFF', (req) =>
  scopeToOwnHandoffs(req.user) ? { l3ToL2AssignedToId: req.user.id } : {},
);
export const clientHandoverQueue = queueFor('CLIENT_HANDOVER_PENDING', (req) => salesOwnerScope(req.user));
// Agreement work spans two statuses: awaiting generation/send + sent to the
// operator for signature. Both stay in this queue until verified.
export const agreementQueue = queueFor(['AGREEMENT_PENDING', 'AGREEMENT_SENT_FOR_SIGNATURE']);

/** GET /api/leads/sidebar-counts — cheap indexed counts for the live badges. */
export const sidebarCounts = async (req, res) => {
  try {
    const statuses = {
      feasibilityPending: 'FEASIBILITY_PENDING',
      pricingPending: 'PRICING_PENDING',
      pendingApproval: 'PENDING_APPROVAL',
      docsPending: 'APPROVED',
      docsVerifyPending: 'DOCS_UPLOADED',
      deliveryReqPending: 'DELIVERY_REQ_PENDING',
      materialApprovalPending: 'MATERIAL_APPROVAL_PENDING',
      dispatchPending: 'AWAITING_DISPATCH',
      installationPending: 'DISPATCHED',
      nocL2Pending: 'NOC_L2_PENDING',
      aggregatorPending: 'AGGREGATOR_CONFIRM_PENDING',
      softwarePending: 'SOFTWARE_PENDING',
      nocL3Pending: 'NOC_L3_PENDING',
      l3ToL2Pending: 'L3_TO_L2_HANDOFF',
      clientHandoverPending: 'CLIENT_HANDOVER_PENDING',
      agreementPending: ['AGREEMENT_PENDING', 'AGREEMENT_SENT_FOR_SIGNATURE'],
    };
    // One grouped count instead of many round-trips on this polled endpoint.
    // Stage totals are global; sales-owned queues are overlaid below scoped to
    // the user, so a multi-access user's non-sales badges stay accurate.
    const grouped = await prisma.lead.groupBy({ by: ['status'], _count: { _all: true } });
    const byStatus = Object.fromEntries(grouped.map((g) => [g.status, g._count._all]));
    const sumOf = (s) => (Array.isArray(s) ? s.reduce((n, v) => n + (byStatus[v] || 0), 0) : byStatus[s] || 0);
    const counts = Object.fromEntries(Object.entries(statuses).map(([k, s]) => [k, sumOf(s)]));

    // Sales-owned queues (pricing / docs / aggregator / client handover) reflect
    // only the user's own leads. Recount just those keys with the owner filter —
    // for a pure sales user this reproduces the old behaviour; for a multi-access
    // user it leaves their stage badges (feasibility, NOC, …) global.
    const ownerScope = salesOwnerScope(req.user);
    if (Object.keys(ownerScope).length) {
      const owned = await prisma.lead.groupBy({ by: ['status'], where: ownerScope, _count: { _all: true } });
      const ownedByStatus = Object.fromEntries(owned.map((g) => [g.status, g._count._all]));
      counts.pricingPending = ownedByStatus.PRICING_PENDING || 0;
      counts.docsPending = ownedByStatus.APPROVED || 0;
      counts.aggregatorPending = ownedByStatus.AGGREGATOR_CONFIRM_PENDING || 0;
      counts.clientHandoverPending = ownedByStatus.CLIENT_HANDOVER_PENDING || 0;
    }

    // The L3→L2 queue shows an L2 user only their assigned handoffs
    // (l3ToL2Queue above) — the badge must count the same rows.
    if (scopeToOwnHandoffs(req.user)) {
      counts.l3ToL2Pending = await prisma.lead.count({
        where: { status: 'L3_TO_L2_HANDOFF', l3ToL2AssignedToId: req.user.id },
      });
    }

    // PO approvals live outside the lead pipeline; the tab is admin-only.
    if (isAdmin(req.user)) {
      counts.poApprovalPending = await prisma.storePurchaseOrder.count({
        where: { status: 'PENDING_ADMIN' },
      });
      // Duplicate-lead requests share the Approvals tab with pricing approvals.
      counts.pendingApproval += await prisma.duplicateLeadApproval.count({
        where: { status: 'PENDING' },
      });
    }

    return res.json({ counts });
  } catch (error) {
    console.error('[lead.sidebarCounts]', error);
    return res.status(500).json({ message: 'Failed to fetch counts.' });
  }
};

// Picker display order — independent of NOC_L3_FIELD_KEYS declaration order.
const BUILTIN_AGGREGATOR_ORDER = ['BNG', 'BIRAS', 'MIKROTIK', 'BGP'];

/** GET /api/leads/aggregator-options — stage-10 picker options (any authenticated staff). */
export const aggregatorOptions = async (req, res) => {
  try {
    const custom = await prisma.aggregatorType.findMany({ orderBy: { name: 'asc' }, select: { name: true } });
    return res.json({ builtins: BUILTIN_AGGREGATOR_ORDER, custom: custom.map((c) => c.name) });
  } catch (error) {
    console.error('[lead.aggregatorOptions]', error);
    return res.status(500).json({ message: 'Failed to fetch aggregator options.' });
  }
};
