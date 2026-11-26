import { Prisma } from '@prisma/client';
import prisma from '../config/db.js';
import { logEvent, diffFields } from './statusChangeLog.service.js';
import { addLeadNote } from './leadNote.service.js';
import {
  resolveFiberRoutes,
  assertAggregatorSelections,
  registerCustomAggregators,
  aggregatorSelectionsOf,
} from './leadStateMachine.js';
import { validateLeadPayload } from '../validation/leadCategories.js';
import { validatePricing } from '../validation/pricing.js';
import { validateFiberRoutes } from '../validation/feasibilityVendors.js';
import { validateIpDetails } from '../validation/ipDetails.js';
import { allowedKeysFor, MULTI_L3_KEYS, toPoolList, normalizeMonitoringSoftware } from '../utils/nocL3Fields.js';
import { isAdmin } from '../utils/roleHelper.js';
import { ensureDefaultDistributor } from '../controllers/distributor.controller.js';

/**
 * Admin "full lead record": read the whole lead in one shot and edit any
 * stage's captured data at any time, without moving the lead's status. Every
 * edit needs a reason and is written to the event log with before/after
 * values. Who-did-what fields (assignees, *At timestamps) are never editable
 * here, and the inventory-linked stages (material request, dispatch) stay
 * read-only so stock counts can't drift.
 */

const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

const str = (v) => {
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
};

const coord = (v, max, label) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || Math.abs(n) > max) throw httpError(400, `${label} must be between -${max} and ${max}.`);
  return n;
};

const user = { select: { id: true, name: true } };

/** Everything the record page shows, in one query. */
const RECORD_INCLUDE = {
  createdBy: user,
  assignedSales: user,
  distributor: { select: { id: true, name: true, isDefault: true } },
  popLocation: { select: { id: true, name: true, latitude: true, longitude: true } },
  feasibilityAssignedTo: user,
  approvedBy: user,
  nocL2AssignedTo: user,
  softwareAssignedTo: user,
  nocL3AssignedTo: user,
  l3ToL2AssignedTo: user,
  agreementVerifiedBy: user,
  documents: {
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, type: true, label: true, fileName: true, mimeType: true, size: true, createdAt: true,
      verificationStatus: true, verificationNote: true, verifiedAt: true, salesApprovedAt: true,
      uploadedBy: user, verifiedBy: user,
    },
  },
  deliveryRequest: {
    include: {
      requestedBy: user,
      superAdminApprovedBy: user,
      superAdminRejectedBy: user,
      assignedToStoreManager: user,
      items: { include: { product: { select: { id: true, modelNumber: true, brandName: true, category: true, unit: true } } } },
    },
  },
  noteEntries: { orderBy: { createdAt: 'asc' } },
};

/** GET the full record (admin only — the route enforces it). */
export const getLeadRecord = async (leadId) => {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, include: RECORD_INCLUDE });
  if (!lead) throw httpError(404, 'Lead not found.');
  return lead;
};

// Lenient IP allocation for admin edits: only the selected types, at most
// `quantity` units each, blank units dropped, unknown keys ignored. Unlike the
// NOC L3 stage, nothing is required — an admin may record partial data.
const buildLenientIpAllocation = (selections, raw) => {
  const alloc = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const { type, quantity } of selections) {
    const allowed = allowedKeysFor(type);
    const units = (Array.isArray(alloc[type]) ? alloc[type] : [])
      .map((u) => {
        const clean = {};
        for (const k of allowed) {
          if (MULTI_L3_KEYS.includes(k)) {
            const list = toPoolList(u?.[k]);
            if (list.length) clean[k] = list;
          } else {
            const v = str(u?.[k]);
            if (v !== null) clean[k] = v;
          }
        }
        return clean;
      })
      .filter((u) => Object.keys(u).length > 0);
    if (units.length > quantity) {
      throw httpError(400, `${type}: at most ${quantity} configuration${quantity === 1 ? '' : 's'} (the selected quantity).`);
    }
    if (units.length) out[type] = units;
  }
  return out;
};

// Each section turns the submitted `data` into a partial Lead update. They
// validate with the same rules as the pipeline forms where those exist.
const SECTIONS = {
  lead: {
    label: 'Lead details',
    stage: 'LEAD',
    build: async (lead, data, actor) => {
      const result = validateLeadPayload({ ...data, category: data?.category ?? lead.category });
      if (!result.ok) throw httpError(400, 'Validation failed.', { errors: result.errors });
      const out = { ...result.data }; // category + contact/location fields + requirementDetails

      // Owner (same rule as the lead form): an active sales user, or the acting admin.
      const ownerId = str(data?.assignedSalesId);
      if (ownerId && ownerId !== lead.assignedSalesId) {
        const target = await prisma.user.findUnique({ where: { id: ownerId }, select: { id: true, accesses: true, isActive: true } });
        if (!target || !target.isActive || (!target.accesses.includes('SALES_USER') && target.id !== actor.id)) {
          throw httpError(400, 'Pick an active sales user as the lead owner.');
        }
        out.assignedSalesId = ownerId;
      }

      // Distributor: ISP leads have none; otherwise an existing pick or GAZON.
      if (out.category === 'ISP') {
        out.distributorId = null;
      } else {
        const distributorId = str(data?.distributorId);
        if (distributorId) {
          const found = await prisma.distributor.findUnique({ where: { id: distributorId }, select: { id: true } });
          if (!found) throw httpError(400, 'The selected distributor no longer exists.');
          out.distributorId = distributorId;
        } else {
          out.distributorId = lead.distributorId ?? (await ensureDefaultDistributor()).id;
        }
      }
      return out;
    },
  },
  feasibility: {
    label: 'Feasibility',
    stage: 'FEASIBILITY',
    build: async (lead, data) => {
      const networkType = str(data?.networkType);
      if (networkType && !['ON_NET', 'OFF_NET'].includes(networkType)) {
        throw httpError(400, 'Network type must be On-net or Off-net.');
      }
      let estimatedDeliveryAt = null;
      if (str(data?.estimatedDeliveryAt)) {
        estimatedDeliveryAt = new Date(data.estimatedDeliveryAt);
        if (Number.isNaN(estimatedDeliveryAt.getTime())) throw httpError(400, 'Estimated delivery must be a valid date.');
      }
      const o = data?.offNet && typeof data.offNet === 'object' ? data.offNet : {};
      const offNet = {
        nearestBts: str(o.nearestBts),
        serviceProvider: str(o.serviceProvider),
        btsLatitude: coord(o.btsLatitude, 90, 'BTS latitude'),
        btsLongitude: coord(o.btsLongitude, 180, 'BTS longitude'),
        portDetails: str(o.portDetails),
      };
      const hasOffNet = Object.values(offNet).some((v) => v !== null);

      // POPs: snapshot each selected POP, keeping the order (first = primary).
      const popIds = [...new Set((Array.isArray(data?.popIds) ? data.popIds : []).filter((x) => typeof x === 'string'))];
      let pops = [];
      if (popIds.length) {
        const found = await prisma.popLocation.findMany({
          where: { id: { in: popIds } },
          select: { id: true, name: true, latitude: true, longitude: true },
        });
        if (found.length !== popIds.length) throw httpError(400, 'A selected POP location no longer exists.');
        const byId = Object.fromEntries(found.map((p) => [p.id, p]));
        pops = popIds.map((id) => byId[id]);
      }
      return {
        feasibilityNotes: str(data?.notes),
        feasibilityNetworkType: networkType,
        feasibilityOffNet: hasOffNet ? offNet : null,
        estimatedDeliveryAt,
        feasibilityPops: pops.length ? pops : null,
        popLocationId: pops[0]?.id ?? null,
      };
    },
  },
  fiber: {
    label: 'Fiber routes',
    stage: 'FEASIBILITY',
    build: async (_lead, data) => {
      const result = validateFiberRoutes(data?.routes);
      if (!result.ok) throw httpError(400, 'Validation failed.', { errors: result.errors });
      return resolveFiberRoutes(result.data);
    },
  },
  pricing: {
    label: 'Pricing',
    stage: 'PRICING',
    build: async (lead, data) => {
      const mix = lead.category === 'ISP' ? lead.requirementDetails?.bandwidthMix : null;
      const result = validatePricing(data, mix);
      if (!result.ok) throw httpError(400, 'Validation failed.', { errors: result.errors });
      // Keep keys older pricing rows carry (lat/long/popId) that the form doesn't edit.
      const merged = { ...(lead.pricing || {}), ...result.data };
      if (!result.data.notes) delete merged.notes;
      return { pricing: merged };
    },
  },
  approval: {
    label: 'Approval',
    stage: 'APPROVAL',
    build: async (_lead, data) => ({
      approvalNotes: str(data?.approvalNotes),
      rejectedReason: str(data?.rejectedReason),
    }),
  },
  ipDetails: {
    label: 'IP details',
    stage: 'DOCS',
    build: async (_lead, data) => {
      const result = validateIpDetails(data || {});
      if (!result.ok) throw httpError(400, 'Validation failed.', { errors: result.errors });
      return { ipDetails: result.data };
    },
  },
  nocL2: {
    label: 'NOC L2 config',
    stage: 'NOC_L2',
    build: async (lead, data) => {
      const configType = str(data?.configType);
      if (configType && !['SWITCH', 'PORT'].includes(configType)) {
        throw httpError(400, 'Config type must be Switch or Port.');
      }
      const base = { ...(lead.nocL2Config || {}) };
      if (configType) base.configType = configType;
      else delete base.configType;
      return {
        nocL2Config: Object.keys(base).length ? base : null,
        nocL2ConfigNotes: str(data?.notes),
      };
    },
  },
  aggregator: {
    label: 'Aggregator',
    stage: 'AGGREGATOR',
    build: async (lead, data) => {
      const selections = assertAggregatorSelections(lead.category, data?.selections)
        .map((s) => ({ type: String(s.type).trim().toUpperCase(), quantity: Math.min(10, Math.max(1, Number(s.quantity) || 1)) }));
      const types = selections.map((s) => s.type);
      return {
        aggregatorSelections: selections,
        aggregatorTypes: types,
        aggregatorType: types[0],
        aggregatorConfirmRemark: str(data?.remark),
        // Keep the recorded IP allocation in step: drop configs for types no
        // longer selected or beyond the new quantity.
        ...(lead.ipAllocation ? { ipAllocation: emptyToNull(buildLenientIpAllocation(selections, pruneToQuantity(selections, lead.ipAllocation))) } : {}),
      };
    },
  },
  software: {
    label: 'Software',
    stage: 'SOFTWARE',
    build: async (lead, data) => {
      // Only ISP operators may run their own portal (then no credentials).
      const managedBy = lead.category === 'ISP' ? str(data?.managedBy) : 'SOFTWARE';
      if (managedBy && !['ISP', 'SOFTWARE'].includes(managedBy)) {
        throw httpError(400, 'Portal must be managed by the ISP or the software team.');
      }
      const ours = managedBy === 'SOFTWARE';
      return {
        portalManagedBy: managedBy,
        portalUsername: ours ? str(data?.portalUsername) : null,
        portalUrl: ours ? str(data?.portalUrl) : null,
        portalPassword: ours ? (data?.portalPassword ?? null) || null : null,
      };
    },
  },
  nocL3: {
    label: 'NOC L3 IP allocation',
    stage: 'NOC_L3',
    build: async (lead, data) => {
      return { ipAllocation: emptyToNull(buildLenientIpAllocation(aggregatorSelectionsOf(lead), data?.ipAllocation)) };
    },
  },
  l3ToL2: {
    label: 'L3 → L2 monitoring',
    stage: 'L3_TO_L2',
    build: async (lead, data) => ({
      nocL2Config: { ...(lead.nocL2Config || {}), software: normalizeMonitoringSoftware(data?.software) },
    }),
  },
};

export const RECORD_SECTIONS = Object.keys(SECTIONS);

const emptyToNull = (obj) => (obj && Object.keys(obj).length ? obj : null);

// Drop units beyond each type's new quantity before the lenient rebuild (which
// would otherwise reject an aggregator change that lowers a quantity).
const pruneToQuantity = (selections, alloc) =>
  Object.fromEntries(
    selections
      .filter((s) => Array.isArray(alloc?.[s.type]))
      .map((s) => [s.type, alloc[s.type].slice(0, s.quantity)]),
  );

// Secrets are logged as "changed", never in clear text.
const SECRET_FIELDS = ['portalPassword'];
const maskSecrets = (changes) =>
  changes.map((c) => (SECRET_FIELDS.includes(c.field) ? { ...c, from: c.from ? '••••••' : null, to: c.to ? '••••••' : null } : c));

// Json columns need DbNull to be cleared.
const JSON_FIELDS = new Set([
  'requirementDetails', 'feasibilityOffNet', 'feasibilityPops', 'feasibilityVendors', 'feasibilityBackupRoutes',
  'pricing', 'ipDetails', 'nocL2Config', 'aggregatorSelections', 'ipAllocation',
]);
const toDbData = (data) =>
  Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v === null && JSON_FIELDS.has(k) ? Prisma.DbNull : v]));

/**
 * Edit one section of a lead's record. Admin only (checked here as well as on
 * the route). Status never changes. Returns the refreshed record.
 */
export const updateLeadRecordSection = async ({ leadId, section, data, reason, actor }) => {
  if (!isAdmin(actor)) throw httpError(403, 'Only admins can edit the full lead record.');
  const def = SECTIONS[section];
  if (!def) throw httpError(400, `Unknown section "${section}".`);
  const why = str(reason);
  if (!why || why.length < 3) throw httpError(400, 'Give a reason for this change (at least 3 characters).');
  if (why.length > 500) throw httpError(400, 'Keep the reason under 500 characters.');

  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) throw httpError(404, 'Lead not found.');

  const built = await def.build(lead, data && typeof data === 'object' ? data : {}, actor);
  // A field the validator left out means "empty" — compare and store it as null.
  const next = Object.fromEntries(Object.entries(built).map(([k, v]) => [k, v === undefined ? null : v]));
  const changes = diffFields(lead, next, Object.keys(next));
  if (!changes.length) throw httpError(400, 'Nothing changed — edit a field before saving.');

  const changed = Object.fromEntries(changes.map((c) => [c.field, next[c.field]]));
  await prisma.lead.update({ where: { id: leadId }, data: toDbData(changed) });
  if (section === 'aggregator') await registerCustomAggregators(changed.aggregatorSelections || [], actor);

  const fieldList = changes.map((c) => c.field).join(', ');
  await addLeadNote({ leadId, stage: def.stage, body: `Admin edited ${def.label}: ${why}`, actor });
  await logEvent({
    action: 'LEAD_ADMIN_EDITED',
    entityType: 'Lead',
    entityId: leadId,
    summary: `Admin edited ${def.label} on ${lead.leadNumber} (${fieldList})`,
    changes: maskSecrets(changes),
    reason: why,
    actor,
  });
  return getLeadRecord(leadId);
};
