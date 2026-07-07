import prisma from '../config/db.js';

const WINDOW_DAYS = { '7d': 7, '30d': 30, all: null };
const DAY = 86400000;

export const normalizeWindow = (w) => (w in WINDOW_DAYS ? w : '30d');

export const windowBounds = (window) => {
  const days = WINDOW_DAYS[window];
  if (days == null) return { floor: null, prevFloor: null };
  const now = Date.now();
  return { floor: new Date(now - days * DAY), prevFloor: new Date(now - 2 * days * DAY) };
};

// Count the actor's own log rows matching `where`, with a delta vs the previous
// equal-length window (delta omitted when window=all).
export const myCount = async (changedById, where, floor, prevFloor) => {
  const base = { changedById, ...where };
  const value = await prisma.statusChangeLog.count({
    where: { ...base, ...(floor ? { createdAt: { gte: floor } } : {}) },
  });
  if (!floor) return { value };
  const prev = await prisma.statusChangeLog.count({
    where: { ...base, createdAt: { gte: prevFloor, lt: floor } },
  });
  return { value, delta: value - prev };
};

// Average days a lead waited in one of `sources` before THIS user moved it out.
export const avgStageDays = async (changedById, sources, floor) => {
  const txns = await prisma.statusChangeLog.findMany({
    where: { changedById, action: 'STATUS_CHANGED', entityType: 'Lead', oldValue: { in: sources }, ...(floor ? { createdAt: { gte: floor } } : {}) },
    select: { entityId: true, oldValue: true, createdAt: true },
  });
  if (!txns.length) return null;
  const ids = [...new Set(txns.map((t) => t.entityId).filter((id) => id != null))];
  const entries = await prisma.statusChangeLog.findMany({
    where: { entityType: 'Lead', entityId: { in: ids }, newValue: { in: sources } },
    select: { entityId: true, newValue: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  const byLead = {};
  for (const e of entries) (byLead[e.entityId] ||= []).push(e);
  const durations = [];
  for (const t of txns) {
    const cand = (byLead[t.entityId] || []).filter(
      (e) => e.newValue === t.oldValue && new Date(e.createdAt) <= new Date(t.createdAt),
    );
    if (cand.length) {
      durations.push((new Date(t.createdAt) - new Date(cand[cand.length - 1].createdAt)) / DAY);
    }
  }
  if (!durations.length) return null;
  return Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10;
};

const humanize = (s) => (s ? s.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '');
const labelForLog = (l) => {
  if (l.action === 'DOC_VERIFIED') return 'Verified a document';
  if (l.action === 'DOC_REJECTED') return 'Rejected a document';
  if (l.action === 'STATUS_CHANGED') return humanize(l.newValue);
  return l.summary || humanize(l.action);
};

const myRecent = async (changedById) => {
  const logs = await prisma.statusChangeLog.findMany({
    where: { changedById },
    orderBy: { createdAt: 'desc' },
    take: 6,
    select: { id: true, action: true, oldValue: true, newValue: true, entityType: true, entityId: true, summary: true, createdAt: true },
  });
  const leadIds = logs.filter((l) => l.entityType === 'Lead' && l.entityId).map((l) => l.entityId);
  const leads = leadIds.length
    ? await prisma.lead.findMany({ where: { id: { in: leadIds } }, select: { id: true, leadNumber: true, organizationName: true } })
    : [];
  const map = Object.fromEntries(leads.map((l) => [l.id, l]));
  return logs.map((l) => ({
    id: l.id,
    leadNumber: map[l.entityId]?.leadNumber || null,
    organizationName: map[l.entityId]?.organizationName || null,
    label: labelForLog(l),
    at: l.createdAt,
  }));
};

// Per-role KPI/breakdown builders are registered here in later tasks.
const BUILDERS = {};
export const registerBuilder = (role, fn) => { BUILDERS[role] = fn; };

// "My leads" = leads assigned to me — same definition the Leads list and notes
// use, so the personal dashboard can't disagree with what the user can open.
const salesOwnedFilter = (uid) => ({ assignedSalesId: uid });

registerBuilder('SALES_USER', async (uid, { floor, prevFloor }) => {
  const owned = salesOwnedFilter(uid);

  const leadsCreatedValue = await prisma.lead.count({ where: { createdById: uid, ...(floor ? { createdAt: { gte: floor } } : {}) } });
  const leadsCreatedDelta = floor
    ? leadsCreatedValue - (await prisma.lead.count({ where: { createdById: uid, createdAt: { gte: prevFloor, lt: floor } } }))
    : undefined;

  // win rate over my owned leads decided in-window — filter the log by the
  // denormalised owner directly (no lead-id pre-fetch + `entityId IN (…)`).
  const terms = await prisma.statusChangeLog.findMany({
    where: { entityType: 'Lead', salesOwnerId: uid, newValue: { in: ['COMPLETED', 'REJECTED'] }, ...(floor ? { createdAt: { gte: floor } } : {}) },
    select: { newValue: true },
  });
  const won = terms.filter((t) => t.newValue === 'COMPLETED').length;
  const lost = terms.filter((t) => t.newValue === 'REJECTED').length;
  const winRate = won + lost ? Math.round((won / (won + lost)) * 100) : null;

  // live pipeline value (active owned leads with pricing)
  const active = await prisma.lead.findMany({ where: { ...owned, status: { notIn: ['COMPLETED', 'REJECTED'] } }, select: { pricing: true } });
  const pipelineValue = active.reduce((s, l) => s + (Number(l?.pricing?.ratePerMonth) || 0), 0);

  // avg lead-create → approved (owned, in-window)
  const ownedLeads = await prisma.lead.findMany({ where: owned, select: { id: true, createdAt: true } });
  const createdAtMap = Object.fromEntries(ownedLeads.map((l) => [l.id, l.createdAt]));
  const apprLogs = await prisma.statusChangeLog.findMany({
    where: { entityType: 'Lead', newValue: 'APPROVED', salesOwnerId: uid, ...(floor ? { createdAt: { gte: floor } } : {}) },
    select: { entityId: true, createdAt: true },
  });
  const apprDurations = apprLogs
    .map((a) => (new Date(a.createdAt) - new Date(createdAtMap[a.entityId])) / 86400000)
    .filter((d) => d >= 0);
  const avgToApproval = apprDurations.length
    ? Math.round((apprDurations.reduce((a, b) => a + b, 0) / apprDurations.length) * 10) / 10
    : null;

  const cats = await prisma.lead.groupBy({ by: ['category'], where: owned, _count: { _all: true } });

  return {
    kpis: [
      { key: 'leadsCreated', label: 'Leads created', value: leadsCreatedValue, format: 'int', delta: leadsCreatedDelta },
      { key: 'winRate', label: 'Win rate', value: winRate, format: 'percent', hint: `${won} won · ${lost} lost` },
      { key: 'pipelineValue', label: 'Pipeline value', value: pipelineValue, format: 'currencyPerMonth', hint: `${active.length} active deals` },
      { key: 'avgToApproval', label: 'Avg → approval', value: avgToApproval, format: 'days' },
    ],
    breakdown: { type: 'donut', title: 'My deal mix', segments: cats.map((c) => ({ label: c.category, value: c._count._all })) },
  };
});

registerBuilder('FEASIBILITY_USER', async (uid, { floor, prevFloor }) => {
  const reviews = await myCount(uid, { action: 'STATUS_CHANGED', oldValue: 'FEASIBILITY_PENDING' }, floor, prevFloor);
  const feasible = await prisma.statusChangeLog.count({
    where: { changedById: uid, action: 'STATUS_CHANGED', oldValue: 'FEASIBILITY_PENDING', newValue: 'PRICING_PENDING', ...(floor ? { createdAt: { gte: floor } } : {}) },
  });
  const notFeasible = reviews.value - feasible;
  const feasibleRate = reviews.value ? Math.round((feasible / reviews.value) * 100) : null;
  const avg = await avgStageDays(uid, ['FEASIBILITY_PENDING'], floor);
  return {
    kpis: [
      { key: 'reviewsDone', label: 'Reviews done', value: reviews.value, format: 'int', delta: reviews.delta },
      { key: 'feasibleRate', label: 'Feasible rate', value: feasibleRate, format: 'percent', hint: `${feasible} feasible · ${notFeasible} not` },
      { key: 'avgReviewTime', label: 'Avg review time', value: avg, format: 'days' },
    ],
    breakdown: { type: 'donut', title: 'Feasible vs not', segments: [{ label: 'Feasible', value: feasible }, { label: 'Not feasible', value: notFeasible }] },
  };
});

registerBuilder('SOFTWARE_USER', async (uid, { floor, prevFloor }) => {
  const verified = await myCount(uid, { action: 'DOC_VERIFIED' }, floor, prevFloor);
  const rejected = await prisma.statusChangeLog.count({
    where: { changedById: uid, action: 'DOC_REJECTED', ...(floor ? { createdAt: { gte: floor } } : {}) },
  });
  const setups = await myCount(uid, { action: 'STATUS_CHANGED', oldValue: 'SOFTWARE_PENDING', newValue: 'NOC_L3_PENDING' }, floor, prevFloor);
  const closed = await myCount(uid, { action: 'STATUS_CHANGED', oldValue: 'AGREEMENT_PENDING', newValue: 'COMPLETED' }, floor, prevFloor);
  return {
    kpis: [
      { key: 'docsVerified', label: 'Docs verified', value: verified.value, format: 'int', delta: verified.delta },
      { key: 'setupsDone', label: 'Software setups', value: setups.value, format: 'int', delta: setups.delta },
      { key: 'agreementsClosed', label: 'Agreements closed', value: closed.value, format: 'int', delta: closed.delta },
    ],
    breakdown: { type: 'donut', title: 'Docs verified vs rejected', segments: [{ label: 'Verified', value: verified.value }, { label: 'Rejected', value: rejected }] },
  };
});

registerBuilder('DELIVERY_USER', async (uid, { floor, prevFloor }) => {
  const reqs = await myCount(uid, { action: 'STATUS_CHANGED', oldValue: 'DELIVERY_REQ_PENDING', newValue: 'AWAITING_DISPATCH' }, floor, prevFloor);
  const installs = await myCount(uid, { action: 'STATUS_CHANGED', oldValue: 'DISPATCHED', newValue: 'NOC_L2_PENDING' }, floor, prevFloor);
  const avg = await avgStageDays(uid, ['DISPATCHED'], floor);
  return {
    kpis: [
      { key: 'requisitionsRaised', label: 'Requisitions raised', value: reqs.value, format: 'int', delta: reqs.delta },
      { key: 'installsCompleted', label: 'Installs completed', value: installs.value, format: 'int', delta: installs.delta },
      { key: 'avgInstallTime', label: 'Avg install time', value: avg, format: 'days' },
    ],
  };
});

registerBuilder('STORE_USER', async (uid, { floor, prevFloor }) => {
  const dispatches = await myCount(uid, { action: 'STATUS_CHANGED', oldValue: 'AWAITING_DISPATCH', newValue: 'DISPATCHED' }, floor, prevFloor);
  const avg = await avgStageDays(uid, ['AWAITING_DISPATCH'], floor);
  const myDispatches = await prisma.dispatch.findMany({
    where: { dispatchedById: uid, ...(floor ? { dispatchedAt: { gte: floor } } : {}) },
    select: { items: true },
  });
  const itemsDispatched = myDispatches.reduce(
    (s, d) => s + (Array.isArray(d.items) ? d.items.reduce((n, it) => n + (Number(it.quantity) || 0), 0) : 0),
    0,
  );
  return {
    kpis: [
      { key: 'dispatchesDone', label: 'Dispatches done', value: dispatches.value, format: 'int', delta: dispatches.delta },
      { key: 'avgDispatchTime', label: 'Avg dispatch turnaround', value: avg, format: 'days' },
      { key: 'itemsDispatched', label: 'Items dispatched', value: itemsDispatched, format: 'int' },
    ],
  };
});

registerBuilder('NOC_L2_USER', async (uid, { floor, prevFloor }) => {
  const configs = await myCount(uid, { action: 'STATUS_CHANGED', oldValue: 'NOC_L2_PENDING', newValue: 'AGGREGATOR_CONFIRM_PENDING' }, floor, prevFloor);
  const handoffs = await myCount(uid, { action: 'STATUS_CHANGED', oldValue: 'L3_TO_L2_HANDOFF', newValue: 'CLIENT_HANDOVER_PENDING' }, floor, prevFloor);
  const avg = await avgStageDays(uid, ['NOC_L2_PENDING', 'L3_TO_L2_HANDOFF'], floor);
  return {
    kpis: [
      { key: 'l2ConfigsDone', label: 'L2 configs done', value: configs.value, format: 'int', delta: configs.delta },
      { key: 'handoffsDone', label: 'L3→L2 handoffs', value: handoffs.value, format: 'int', delta: handoffs.delta },
      { key: 'avgTurnaround', label: 'Avg turnaround', value: avg, format: 'days' },
    ],
  };
});

registerBuilder('NOC_L3_USER', async (uid, { floor, prevFloor }) => {
  const allocations = await myCount(uid, { action: 'STATUS_CHANGED', oldValue: 'NOC_L3_PENDING', newValue: 'L3_TO_L2_HANDOFF' }, floor, prevFloor);
  const avg = await avgStageDays(uid, ['NOC_L3_PENDING'], floor);
  return {
    kpis: [
      { key: 'allocationsDone', label: 'IP allocations done', value: allocations.value, format: 'int', delta: allocations.delta },
      { key: 'avgTurnaround', label: 'Avg turnaround', value: avg, format: 'days' },
    ],
  };
});

export const buildMyDashboard = async (user, window) => {
  const w = normalizeWindow(window);
  const { floor, prevFloor } = windowBounds(w);
  const builder = BUILDERS[user.role];
  const data = builder ? await builder(user.id, { floor, prevFloor }) : { kpis: [] };
  const recent = await myRecent(user.id);
  return { role: user.role, window: w, kpis: data.kpis || [], breakdown: data.breakdown || null, recent };
};
