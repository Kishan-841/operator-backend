import prisma from '../config/db.js';
import { buildMyDashboard } from '../services/dashboard.service.js';

// Pipeline order for the funnel.
const PIPELINE = [
  'NEW',
  'FEASIBILITY_PENDING',
  'PRICING_PENDING',
  'PENDING_APPROVAL',
  'APPROVED',
  'DOCS_UPLOADED',
  'DELIVERY_REQ_PENDING',
  'AWAITING_DISPATCH',
  'DISPATCHED',
  'NOC_L2_PENDING',
  'AGGREGATOR_CONFIRM_PENDING',
  'SOFTWARE_PENDING',
  'NOC_L3_PENDING',
  'L3_TO_L2_HANDOFF',
  'CLIENT_HANDOVER_PENDING',
  'AGREEMENT_PENDING',
  'AGREEMENT_SENT_FOR_SIGNATURE',
  'COMPLETED',
];

const MS_PER_DAY = 1000 * 60 * 60 * 24;
// Average Gregorian month — used to pro-rate "estimated collected to date".
const MS_PER_MONTH = MS_PER_DAY * 30.44;

// What an onboarded operator pays us per month: the stage-3 agreed price after
// discount, falling back to the raw rate for older leads without finalPrice.
const monthlyValueOf = (pricing) =>
  Number(pricing?.finalPrice ?? pricing?.ratePerMonth) || 0;

// Canonical order for the four deal flavours — keep in sync with the FE
// CATEGORIES list. We always emit all four (even at zero) so the dashboard
// renders a stable 4-up grid.
const CATEGORY_ORDER = ['PIN_RATE', 'JV', 'REVENUE_SHARING', 'ISP'];

// --- numeric helpers for lead-metrics averaging ---
const numPos = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const numPct = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null; // 0% is a valid split
};
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

// User count lives under different keys per category; ISP has none.
const userCountOf = (lead) => {
  const r = lead.requirementDetails || {};
  if (lead.category === 'PIN_RATE') return numPos(r.estimatedUserCount);
  if (lead.category === 'JV' || lead.category === 'REVENUE_SHARING') return numPos(r.userCount);
  return null; // ISP
};

const monthKey = (d) => {
  const dt = new Date(d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
};

/**
 * Revenue rollup across onboarded (COMPLETED) operators.
 * - mrr: live monthly run-rate (Σ monthlyValue)
 * - estCollected: Σ monthlyValue × months since each operator onboarded
 *   (pro-rated by days — an estimate, there is no invoicing module)
 * - growth: last 12 months of onboardings + cumulative MRR curve
 */
// True when a lat/long pair is usable on a map — 0,0 is the app-wide
// "coordinates unknown" sentinel (see PincodePicker on the frontend).
const realCoords = (lat, lng) =>
  lat != null && lng != null && !(Number(lat) === 0 && Number(lng) === 0);

const buildRevenue = (completedLeads, onboardedAtByLead, now = new Date()) => {
  const operators = completedLeads
    .map((l) => ({
      id: l.id,
      leadNumber: l.leadNumber,
      organizationName: l.organizationName,
      category: l.category,
      // Marker coords for the delivered-operators map (resolved in overview).
      latitude: l.latitude ?? null,
      longitude: l.longitude ?? null,
      // Fallback for the rare lead whose COMPLETED audit row was lost.
      onboardedAt: onboardedAtByLead[l.id] || l.updatedAt,
      monthlyValue: monthlyValueOf(l.pricing),
    }))
    .sort((a, b) => b.monthlyValue - a.monthlyValue);

  const mrr = operators.reduce((s, o) => s + o.monthlyValue, 0);
  const estCollected = Math.round(
    operators.reduce((s, o) => {
      const months = Math.max(0, (now - new Date(o.onboardedAt)) / MS_PER_MONTH);
      return s + o.monthlyValue * months;
    }, 0),
  );

  const byCategoryMap = {};
  for (const o of operators) {
    const e = (byCategoryMap[o.category] ||= { category: o.category, mrr: 0, count: 0 });
    e.mrr += o.monthlyValue;
    e.count += 1;
  }

  // Last 12 calendar months (oldest first); cumulative MRR starts from anything
  // onboarded before the window so the curve never under-reports.
  const months = [];
  for (let i = 11; i >= 0; i -= 1) {
    months.push(monthKey(new Date(now.getFullYear(), now.getMonth() - i, 1)));
  }
  const windowStart = new Date(now.getFullYear(), now.getMonth() - 11, 1);
  let cumulativeMrr = operators
    .filter((o) => new Date(o.onboardedAt) < windowStart)
    .reduce((s, o) => s + o.monthlyValue, 0);
  const inWindow = operators.filter((o) => new Date(o.onboardedAt) >= windowStart);
  const growth = months.map((month) => {
    const ops = inWindow.filter((o) => monthKey(o.onboardedAt) === month);
    cumulativeMrr += ops.reduce((s, o) => s + o.monthlyValue, 0);
    return { month, onboarded: ops.length, cumulativeMrr };
  });

  return {
    mrr,
    estCollected,
    onboardedCount: operators.length,
    avgValue: operators.length ? Math.round(mrr / operators.length) : 0,
    byCategory: Object.values(byCategoryMap).sort((a, b) => b.mrr - a.mrr),
    growth,
    operators,
  };
};

const QUEUE_META = {
  FEASIBILITY_PENDING: { label: 'Feasibility', href: '/dashboard/feasibility-queue' },
  PRICING_PENDING: { label: 'Pricing', href: '/dashboard/pricing-queue' },
  PENDING_APPROVAL: { label: 'Approvals', href: '/dashboard/approvals' },
  APPROVED: { label: 'Docs upload', href: '/dashboard/docs-queue' },
  DOCS_UPLOADED: { label: 'Docs verify', href: '/dashboard/docs-verify' },
  DELIVERY_REQ_PENDING: { label: 'Delivery', href: '/dashboard/delivery-queue' },
  AWAITING_DISPATCH: { label: 'Store dispatch', href: '/dashboard/store-dispatch' },
  DISPATCHED: { label: 'Installation', href: '/dashboard/installation-queue' },
  NOC_L2_PENDING: { label: 'NOC L2', href: '/dashboard/noc-l2-queue' },
  AGGREGATOR_CONFIRM_PENDING: { label: 'Aggregator confirm', href: '/dashboard/aggregator-confirm' },
  SOFTWARE_PENDING: { label: 'Software', href: '/dashboard/software-queue' },
  NOC_L3_PENDING: { label: 'NOC L3', href: '/dashboard/noc-l3-queue' },
  L3_TO_L2_HANDOFF: { label: 'L3→L2 handoff', href: '/dashboard/l3-to-l2-handoff' },
  CLIENT_HANDOVER_PENDING: { label: 'Client handover', href: '/dashboard/client-handover' },
  AGREEMENT_PENDING: { label: 'Agreement', href: '/dashboard/agreement-queue' },
  AGREEMENT_SENT_FOR_SIGNATURE: { label: 'Agreement (sent for signature)', href: '/dashboard/agreement-queue' },
};

/** GET /api/reports/overview?salesUserId=<id> (admin) — KPIs, category mix,
 *  audit-based funnel, per-territory mix, throughput, and a recent-activity feed.
 *  When salesUserId is given, every figure is scoped to that sales user's leads. */
export const overview = async (req, res) => {
  try {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    // Scope: filter leads by owner, and audit/log queries by the denormalised
    // owner column — a direct indexed filter (no `entityId IN (…)` id resolution).
    const salesUserId = req.query.salesUserId || null;
    const leadWhere = salesUserId ? { assignedSalesId: salesUserId } : {};
    const logScope = salesUserId ? { salesOwnerId: salesUserId } : {};
    const logBase = { entityType: 'Lead', action: 'STATUS_CHANGED', ...logScope };

    const [total, completed, rejected, byStatusRaw, byTerritoryRaw, reachedRaw, completedThisMonth, recentLogs, completedLogs, salesUsers] =
      await Promise.all([
        prisma.lead.count({ where: leadWhere }),
        prisma.lead.count({ where: { ...leadWhere, status: 'COMPLETED' } }),
        prisma.lead.count({ where: { ...leadWhere, status: 'REJECTED' } }),
        prisma.lead.groupBy({ by: ['status'], where: leadWhere, _count: { _all: true } }),
        prisma.lead.groupBy({
          by: ['territory'],
          where: { ...leadWhere, territory: { not: null } },
          _count: { _all: true },
        }),
        // Distinct-ish "ever reached" per stage from the audit log (one entry per
        // lead per transition in the happy path).
        prisma.statusChangeLog.groupBy({
          by: ['newValue'],
          where: logBase,
          _count: { _all: true },
        }),
        prisma.statusChangeLog.count({
          where: { ...logBase, newValue: 'COMPLETED', createdAt: { gte: startOfMonth } },
        }),
        prisma.statusChangeLog.findMany({
          where: logBase,
          orderBy: { createdAt: 'desc' },
          take: 8,
          include: { changedBy: { select: { name: true } } },
        }),
        prisma.statusChangeLog.findMany({
          where: { ...logBase, newValue: 'COMPLETED' },
          select: { entityId: true, createdAt: true },
        }),
        prisma.user.findMany({
          where: { role: 'SALES_USER' },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
      ]);

    const active = total - completed - rejected;

    // ONE lead scan powers the category breakdown, pipeline value, AND revenue —
    // we fold it in JS rather than re-querying the table three times. Selecting
    // the revenue fields here lets `completedLeads`/`activeWithPricing` be derived
    // below instead of two more findMany calls.
    const allLeads = await prisma.lead.findMany({
      where: leadWhere,
      select: {
        id: true,
        leadNumber: true,
        organizationName: true,
        category: true,
        status: true,
        pricing: true,
        updatedAt: true,
        latitude: true,
        longitude: true,
        pincode: true,
      },
    });
    const categoryStats = Object.fromEntries(
      CATEGORY_ORDER.map((c) => [c, { category: c, count: 0, active: 0, won: 0, totalValue: 0, pricedCount: 0 }]),
    );
    for (const l of allLeads) {
      const e = (categoryStats[l.category] ||= {
        category: l.category,
        count: 0,
        active: 0,
        won: 0,
        totalValue: 0,
        pricedCount: 0,
      });
      e.count += 1;
      if (l.status === 'COMPLETED') e.won += 1;
      else if (l.status !== 'REJECTED') e.active += 1;
      const value = monthlyValueOf(l.pricing);
      if (value > 0) {
        e.totalValue += value;
        e.pricedCount += 1;
      }
    }
    const byCategory = CATEGORY_ORDER.map((c) => {
      const e = categoryStats[c];
      return {
        category: c,
        count: e.count,
        active: e.active,
        won: e.won,
        totalValue: e.totalValue,
        avgValue: e.pricedCount ? Math.round(e.totalValue / e.pricedCount) : 0,
        share: total ? Math.round((e.count / total) * 100) : 0,
      };
    });
    const byTerritory = byTerritoryRaw
      .map((r) => ({ territory: r.territory, count: r._count._all }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);
    const currentMap = Object.fromEntries(byStatusRaw.map((r) => [r.status, r._count._all]));
    const reachedMap = Object.fromEntries(reachedRaw.map((r) => [r.newValue, r._count._all]));

    const funnel = PIPELINE.map((status) => ({
      status,
      reached: status === 'NEW' ? total : reachedMap[status] || 0,
      current: currentMap[status] || 0,
    }));

    // Resolve lead identity for the recent-activity feed + cycle-time calc.
    const leadIds = [
      ...new Set([...recentLogs.map((l) => l.entityId), ...completedLogs.map((l) => l.entityId)]),
    ];
    const leads = leadIds.length
      ? await prisma.lead.findMany({
          where: { id: { in: leadIds } },
          select: { id: true, leadNumber: true, organizationName: true, createdAt: true },
        })
      : [];
    const leadMap = Object.fromEntries(leads.map((l) => [l.id, l]));

    const recentActivity = recentLogs.map((log) => {
      const lead = leadMap[log.entityId];
      return {
        id: log.id,
        leadNumber: lead?.leadNumber || null,
        organizationName: lead?.organizationName || null,
        oldValue: log.oldValue,
        newValue: log.newValue,
        changedBy: log.changedBy?.name || 'System',
        createdAt: log.createdAt,
      };
    });

    // Average cycle time: days from lead creation to its COMPLETED transition.
    const cycleDurations = completedLogs
      .map((log) => {
        const lead = leadMap[log.entityId];
        if (!lead) return null;
        return (new Date(log.createdAt) - new Date(lead.createdAt)) / MS_PER_DAY;
      })
      .filter((d) => d !== null && d >= 0);
    const avgCycleDays = cycleDurations.length
      ? Math.round((cycleDurations.reduce((a, b) => a + b, 0) / cycleDurations.length) * 10) / 10
      : null;

    const decided = completed + rejected;
    const throughput = {
      winRate: decided ? Math.round((completed / decided) * 100) : null,
      completedThisMonth,
      avgCycleDays,
    };

    // Derived from the single allLeads scan above — no extra round-trips.
    const totalPipelineValue = allLeads
      .filter((l) => l.status !== 'COMPLETED' && l.status !== 'REJECTED')
      .reduce((s, l) => s + (Number(l?.pricing?.ratePerMonth) || 0), 0);

    // Revenue from onboarded operators. Onboarding date = the (latest) audit
    // entry that moved the lead to COMPLETED.
    const completedLeads = allLeads.filter((l) => l.status === 'COMPLETED');

    // Resolve map coords for delivered operators: the lead's own lat/long wins;
    // a missing/0,0 pair falls back to the pincode master's centroid; anything
    // still unknown ships as null so the map can skip it.
    const noCoords = completedLeads.filter((l) => !realCoords(l.latitude, l.longitude) && l.pincode);
    if (noCoords.length) {
      const rows = await prisma.pincode.findMany({
        where: { pincode: { in: [...new Set(noCoords.map((l) => l.pincode))] } },
        select: { pincode: true, latitude: true, longitude: true },
      });
      const byPin = {};
      for (const p of rows) {
        if (realCoords(p.latitude, p.longitude) && !byPin[p.pincode]) byPin[p.pincode] = p;
      }
      for (const l of noCoords) {
        const p = byPin[l.pincode];
        if (p) {
          l.latitude = p.latitude;
          l.longitude = p.longitude;
        }
      }
    }
    for (const l of completedLeads) {
      if (!realCoords(l.latitude, l.longitude)) {
        l.latitude = null;
        l.longitude = null;
      }
    }

    const onboardedAtByLead = {};
    for (const log of completedLogs) {
      const prev = onboardedAtByLead[log.entityId];
      if (!prev || new Date(log.createdAt) > new Date(prev)) {
        onboardedAtByLead[log.entityId] = log.createdAt;
      }
    }
    const revenue = {
      ...buildRevenue(completedLeads, onboardedAtByLead),
      newThisMonth: completedThisMonth,
    };

    const workloadByTeam = funnel
      .filter((f) => QUEUE_META[f.status])
      .map((f) => ({ status: f.status, label: QUEUE_META[f.status].label, href: QUEUE_META[f.status].href, count: f.current }));

    return res.json({
      kpis: { total, active, completed, rejected },
      byCategory,
      byTerritory,
      funnel,
      throughput,
      recentActivity,
      totalPipelineValue,
      revenue,
      workloadByTeam,
      salesUsers,
    });
  } catch (error) {
    console.error('[report.overview]', error);
    return res.status(500).json({ message: 'Failed to build report.' });
  }
};

/**
 * GET /api/reports/lead-metrics?salesUserId=<id> (admin) — the multi-view metrics
 * block: four "common factor" KPIs (leads, converted, avg user count, avg rate)
 * at the overall level and per category, optionally scoped to one sales user.
 */
export const leadMetrics = async (req, res) => {
  try {
    const salesUserId = req.query.salesUserId || null;
    const where = salesUserId ? { assignedSalesId: salesUserId } : {};

    const [leads, salesUsers] = await Promise.all([
      prisma.lead.findMany({
        where,
        select: { category: true, status: true, assignedSalesId: true, requirementDetails: true, pricing: true },
      }),
      prisma.user.findMany({
        where: { role: 'SALES_USER' },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
    ]);

    // Leads + converted + not-feasible + avg user count for any subset.
    const baseFor = (subset) => {
      const counts = subset.map(userCountOf).filter((v) => v != null);
      const avg = mean(counts);
      return {
        leads: subset.length,
        converted: subset.filter((l) => l.status === 'COMPLETED').length,
        notFeasible: subset.filter((l) => l.status === 'REJECTED').length,
        avgUserCount: avg == null ? null : Math.round(avg),
      };
    };
    // Avg rate is the monthly pricing run-rate (₹/mo), the only unit
    // comparable across categories.
    const avgMonthlyFor = (subset) => {
      const vals = subset.map((l) => monthlyValueOf(l.pricing)).filter((v) => v > 0);
      return vals.length ? Math.round(mean(vals)) : null;
    };

    const overall = {
      ...baseFor(leads),
      avgRateMonthly: avgMonthlyFor(leads),
    };

    // Native rate unit for a category subset (also computed per sales user, so
    // the filtered right-hand panel can mirror the category's own stats).
    const rateFor = (category, subset) => {
      let rate;
      if (category === 'PIN_RATE') {
        const vals = subset.map((l) => numPos(l.requirementDetails?.ratePerUser)).filter((v) => v != null);
        rate = { kind: 'PER_USER', value: round1(mean(vals)) };
      } else if (category === 'JV') {
        const vals = subset.map((l) => numPct(l.requirementDetails?.percentageSplit)).filter((v) => v != null);
        rate = { kind: 'PERCENT', value: round1(mean(vals)) };
      } else if (category === 'REVENUE_SHARING') {
        // Legacy RS leads predate rateType — treat them as percentage.
        const pctVals = subset
          .filter((l) => (l.requirementDetails?.rateType ?? 'PERCENTAGE') === 'PERCENTAGE')
          .map((l) => numPct(l.requirementDetails?.percentageSplit))
          .filter((v) => v != null);
        const fixedVals = subset
          .filter((l) => l.requirementDetails?.rateType === 'FIXED')
          .map((l) => numPos(l.requirementDetails?.fixedRate))
          .filter((v) => v != null);
        const fixedAvg = mean(fixedVals);
        rate = {
          kind: 'RS',
          pct: round1(mean(pctVals)),
          fixed: fixedAvg == null ? null : Math.round(fixedAvg),
        };
      } else {
        rate = { kind: 'NONE' }; // ISP
      }
      return rate;
    };

    // The same stat block per sales owner — the filtered right-hand panel of
    // each By-Category row mirrors the category stats for one user.
    const splitBySalesUser = (category, subset) =>
      salesUsers.map((u) => {
        const mine = subset.filter((l) => l.assignedSalesId === u.id);
        return { id: u.id, name: u.name, ...baseFor(mine), rate: rateFor(category, mine) };
      });

    // Per category — native rate unit.
    const byCategory = CATEGORY_ORDER.map((category) => {
      const subset = leads.filter((l) => l.category === category);
      return {
        category,
        ...baseFor(subset),
        rate: rateFor(category, subset),
        bySalesUser: splitBySalesUser(category, subset),
      };
    });

    return res.json({ overall, byCategory, salesUsers });
  } catch (error) {
    console.error('[report.leadMetrics]', error);
    return res.status(500).json({ message: 'Failed to build lead metrics.' });
  }
};

/** GET /api/reports/my-dashboard?window=7d|30d|all — the caller's personal dashboard. */
export const myDashboard = async (req, res) => {
  try {
    const data = await buildMyDashboard(req.user, req.query.window);
    return res.json(data);
  } catch (error) {
    console.error('[report.myDashboard]', error);
    return res.status(500).json({ message: 'Failed to build dashboard.' });
  }
};
