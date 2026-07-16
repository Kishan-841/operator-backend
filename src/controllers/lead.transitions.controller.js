import * as sm from '../services/leadStateMachine.js';
import prisma from '../config/db.js';
import { validatePricing } from '../validation/pricing.js';
import { validateFeasibilityVendors } from '../validation/feasibilityVendors.js';
import { validateMaterialReq } from '../validation/stage4.js';
import { validateAggregator, validateIpAllocation } from '../validation/stage5.js';
import { actorFromReq } from '../utils/requestContext.js';

// Free-text body fields (notes / reason / config notes / portal creds) must be
// strings — coerce anything else to null so a stray object/number can't reach
// Prisma and 500 (required-text guards in the state machine then 400 cleanly).
const asText = (v) => (typeof v === 'string' ? v : null);

// Map a state-machine error (carrying .status) to a response.
const fail = (res, error) => {
  if (error?.status) return res.status(error.status).json({ message: error.message });
  console.error('[lead.transition]', error);
  return res.status(500).json({ message: 'Transition failed.' });
};

/** POST /api/leads/:id/submit-feasibility (SALES_USER) */
export const submitFeasibility = async (req, res) => {
  try {
    const data = await sm.submitForFeasibility({ leadId: req.params.id, actor: actorFromReq(req) });
    return res.json({ message: 'Submitted for feasibility.', data });
  } catch (error) {
    return fail(res, error);
  }
};

/** POST /api/leads/:id/feasibility (FEASIBILITY_USER) { feasible, notes, vendors? } */
const parseCoord = (v, max) => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || Math.abs(n) > max) return NaN; // signals invalid
  return n;
};

export const completeFeasibility = async (req, res) => {
  try {
    const { feasible, notes, vendors, popLocationId, networkType } = req.body || {};
    if (typeof feasible !== 'boolean') {
      return res.status(400).json({ message: 'feasible (boolean) is required.' });
    }
    if (networkType != null && !['ON_NET', 'OFF_NET'].includes(networkType)) {
      return res.status(400).json({ message: 'networkType must be ON_NET or OFF_NET.' });
    }
    // On the feasible path, validate the fiber segment list (Own Network / vendors).
    let segments;
    if (feasible) {
      const result = validateFeasibilityVendors(vendors);
      if (!result.ok) {
        return res.status(400).json({ message: 'Validation failed.', errors: result.errors });
      }
      segments = result.data;
    }
    const latitude = parseCoord(req.body?.latitude, 90);
    const longitude = parseCoord(req.body?.longitude, 180);
    if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
      return res.status(400).json({ message: 'Latitude/longitude are out of range.' });
    }

    // Optional estimated delivery date (feasible path) — reject garbage early.
    const estRaw = req.body?.estimatedDeliveryAt;
    let estimatedDeliveryAt;
    if (estRaw !== undefined && estRaw !== null && estRaw !== '') {
      const d = new Date(estRaw);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({ message: 'estimatedDeliveryAt must be a valid date.' });
      }
      estimatedDeliveryAt = d;
    }

    // Multiple POPs: array of ids (falls back to the legacy single popLocationId).
    const popIds = Array.isArray(req.body?.pops)
      ? req.body.pops.filter((x) => typeof x === 'string')
      : popLocationId
        ? [popLocationId]
        : [];

    // Off-net serving details.
    const raw = req.body?.offNet && typeof req.body.offNet === 'object' ? req.body.offNet : null;
    const btsLat = parseCoord(raw?.btsLatitude, 90);
    const btsLng = parseCoord(raw?.btsLongitude, 180);
    if (Number.isNaN(btsLat) || Number.isNaN(btsLng)) {
      return res.status(400).json({ message: 'BTS latitude/longitude are out of range.' });
    }
    const str = (v) => String(v ?? '').trim() || null;
    const offNet = raw
      ? {
          nearestBts: str(raw.nearestBts),
          serviceProvider: str(raw.serviceProvider),
          btsLatitude: btsLat ?? null,
          btsLongitude: btsLng ?? null,
          portDetails: str(raw.portDetails),
        }
      : null;

    const data = await sm.completeFeasibility({
      leadId: req.params.id,
      actor: actorFromReq(req),
      feasible,
      notes: asText(notes),
      vendors: segments,
      popIds,
      latitude,
      longitude,
      networkType: networkType ?? null,
      offNet,
      estimatedDeliveryAt,
    });
    return res.json({ message: 'Feasibility recorded.', data });
  } catch (error) {
    return fail(res, error);
  }
};

/** POST /api/leads/:id/pricing (SALES_USER) { pricing } */
export const submitPricing = async (req, res) => {
  try {
    // ISP leads are priced per bandwidth requirement — the validator needs the
    // lead's selected mix to demand one amount per requirement.
    const lead = await prisma.lead.findUnique({
      where: { id: req.params.id },
      select: { category: true, requirementDetails: true },
    });
    if (!lead) return res.status(404).json({ message: 'Lead not found.' });
    const bandwidthMix = lead.category === 'ISP' ? lead.requirementDetails?.bandwidthMix ?? [] : null;
    const result = validatePricing(req.body?.pricing ?? req.body, bandwidthMix);
    if (!result.ok) {
      return res.status(400).json({ message: 'Invalid pricing.', errors: result.errors });
    }
    const data = await sm.submitPricing({ leadId: req.params.id, actor: actorFromReq(req), pricing: result.data });
    return res.json({ message: 'Pricing submitted.', data });
  } catch (error) {
    return fail(res, error);
  }
};

/** POST /api/leads/:id/approve (ADMIN) */
export const approveLead = async (req, res) => {
  try {
    const data = await sm.approveLead({
      leadId: req.params.id,
      actor: actorFromReq(req),
      notes: asText(req.body?.notes),
    });
    return res.json({ message: 'Lead approved.', data });
  } catch (error) {
    return fail(res, error);
  }
};

/** POST /api/leads/:id/reject (ADMIN) { reason } */
export const rejectLead = async (req, res) => {
  try {
    const data = await sm.rejectLead({ leadId: req.params.id, actor: actorFromReq(req), reason: asText(req.body?.reason) });
    return res.json({ message: 'Sent back to sales to revise pricing.', data });
  } catch (error) {
    return fail(res, error);
  }
};

/** POST /api/leads/:id/submit-docs-verification (SALES) */
export const submitDocsForVerification = async (req, res) => {
  try {
    const data = await sm.submitDocsForVerification({ leadId: req.params.id, actor: actorFromReq(req) });
    return res.json({ message: 'Documents sent for verification.', data });
  } catch (error) {
    return fail(res, error);
  }
};

/** POST /api/leads/:id/complete-docs (SALES) */
export const completeDocs = async (req, res) => {
  try {
    const data = await sm.completeDocs({ leadId: req.params.id, actor: actorFromReq(req) });
    return res.json({ message: 'Documents completed.', data });
  } catch (error) {
    return fail(res, error);
  }
};

/** POST /api/leads/:id/skip-material (DELIVERY) { reason? } — no material needed. */
export const skipMaterialReq = async (req, res) => {
  try {
    const data = await sm.skipMaterialReq({
      leadId: req.params.id,
      actor: actorFromReq(req),
      reason: asText(req.body?.reason),
    });
    return res.json({ message: 'Marked as no material required — moved to installation.', data });
  } catch (error) {
    return fail(res, error);
  }
};

/** POST /api/leads/:id/material-req (DELIVERY) { items:[{productId,quantity}], deliveryAddress?, urgency?, notes? } */
export const submitMaterialReq = async (req, res) => {
  try {
    const result = validateMaterialReq(req.body);
    if (!result.ok) {
      return res.status(400).json({ message: 'Invalid material request.', errors: result.errors });
    }
    const data = await sm.submitMaterialReq({ leadId: req.params.id, actor: actorFromReq(req), ...result.data });
    return res.json({ message: 'Material request submitted for approval.', data });
  } catch (error) {
    return fail(res, error);
  }
};

/** POST /api/leads/:id/approve-material (ADMIN) */
export const approveMaterialRequest = async (req, res) => {
  try {
    const data = await sm.approveMaterialRequest({ leadId: req.params.id, actor: actorFromReq(req) });
    return res.json({ message: 'Material request approved.', data });
  } catch (error) {
    return fail(res, error);
  }
};

/** POST /api/leads/:id/reject-material (ADMIN) { reason } */
export const rejectMaterialRequest = async (req, res) => {
  try {
    const data = await sm.rejectMaterialRequest({
      leadId: req.params.id,
      actor: actorFromReq(req),
      reason: asText(req.body?.reason),
    });
    return res.json({ message: 'Material request sent back.', data });
  } catch (error) {
    return fail(res, error);
  }
};

/** POST /api/leads/:id/assign-material (STORE) { assignments } */
export const assignMaterial = async (req, res) => {
  try {
    const assignments = req.body?.assignments;
    if (!Array.isArray(assignments)) {
      return res.status(400).json({ message: 'An assignments array is required.' });
    }
    const data = await sm.assignMaterial({ leadId: req.params.id, actor: actorFromReq(req), assignments });
    return res.json({ message: 'Material assigned & dispatched.', data });
  } catch (error) {
    return fail(res, error);
  }
};

/** POST /api/leads/:id/install (DELIVERY) { notes? } */
export const completeInstallation = async (req, res) => {
  try {
    const data = await sm.completeInstallation({
      leadId: req.params.id,
      actor: actorFromReq(req),
      notes: asText(req.body?.notes),
    });
    return res.json({ message: 'Installation recorded.', data });
  } catch (error) {
    return fail(res, error);
  }
};

/** POST /api/leads/:id/noc-l2 (NOC_L2) { configNotes?, config? } */
const SOFTWARE_KEYS = ['opm', 'dude', 'cacti'];
const normalizeNocL2Config = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const configType = raw.configType === 'PORT' ? 'PORT' : 'SWITCH';
  const software = {};
  for (const k of SOFTWARE_KEYS) software[k] = Boolean(raw.software?.[k]);
  return { configType, software };
};

export const completeNocL2 = async (req, res) => {
  try {
    const config = normalizeNocL2Config(req.body?.config);
    if (!config || !SOFTWARE_KEYS.every((k) => config.software[k])) {
      return res.status(400).json({
        message: 'Complete all monitoring entries (OPM, DUDE, CACTI) before finishing L2 config.',
      });
    }
    const data = await sm.completeNocL2({
      leadId: req.params.id,
      actor: actorFromReq(req),
      configNotes: asText(req.body?.configNotes),
      config,
    });
    return res.json({ message: 'NOC L2 config recorded.', data });
  } catch (error) {
    return fail(res, error);
  }
};

/** POST /api/leads/:id/aggregator (SALES) { aggregatorTypes: string[], remark? } (legacy single aggregatorType accepted) */
export const confirmAggregator = async (req, res) => {
  try {
    const result = validateAggregator(req.body);
    if (!result.ok) {
      return res.status(400).json({ message: 'Invalid aggregator confirmation.', errors: result.errors });
    }
    const data = await sm.confirmAggregator({ leadId: req.params.id, actor: actorFromReq(req), ...result.data });
    return res.json({ message: 'Aggregator confirmed.', data });
  } catch (error) {
    return fail(res, error);
  }
};

/** POST /api/leads/:id/software (SOFTWARE) { portalUsername?, notes? } */
export const completeSoftware = async (req, res) => {
  try {
    // Only accept http(s) portal URLs — blocks javascript:/data: URIs that would
    // become a stored-XSS vector when later rendered as a link.
    const rawUrl = String(req.body?.portalUrl ?? '').trim();
    let portalUrl = null;
    if (rawUrl) {
      let proto = '';
      try {
        proto = new URL(rawUrl).protocol;
      } catch {
        proto = '';
      }
      if (proto !== 'http:' && proto !== 'https:') {
        return res.status(400).json({ message: 'Portal URL must start with http:// or https://.' });
      }
      portalUrl = rawUrl;
    }
    const data = await sm.completeSoftware({
      leadId: req.params.id,
      actor: actorFromReq(req),
      managedBy: asText(req.body?.managedBy),
      portalUsername: asText(req.body?.portalUsername),
      portalUrl,
      portalPassword: asText(req.body?.portalPassword),
      notes: asText(req.body?.notes),
    });
    return res.json({ message: 'Software setup recorded.', data });
  } catch (error) {
    return fail(res, error);
  }
};

/** POST /api/leads/:id/noc-l3 (NOC_L3) { <AGGREGATOR>: [ { <fieldKey>: value }, ... ] } — one entry per UNIT selected at stage 10 */
export const completeNocL3 = async (req, res) => {
  try {
    const result = validateIpAllocation(req.body);
    if (!result.ok) {
      return res.status(400).json({ message: 'Invalid IP allocation.', errors: result.errors });
    }
    const data = await sm.completeNocL3({ leadId: req.params.id, actor: actorFromReq(req), ipAllocation: result.data });
    return res.json({ message: 'IP allocation recorded.', data });
  } catch (error) {
    return fail(res, error);
  }
};

/** POST /api/leads/:id/l3-to-l2 (NOC_L2) { notes? } */
export const completeL3ToL2 = async (req, res) => {
  try {
    const data = await sm.completeL3ToL2({
      leadId: req.params.id,
      actor: actorFromReq(req),
      notes: asText(req.body?.notes),
    });
    return res.json({ message: 'L3→L2 assignment recorded.', data });
  } catch (error) {
    return fail(res, error);
  }
};

/** POST /api/leads/:id/l3-to-l2/assign (NOC_L3) { assignedToId } */
export const assignL3ToL2 = async (req, res) => {
  try {
    const assignedToId = req.body?.assignedToId;
    if (!assignedToId) {
      return res.status(400).json({ message: 'Select a NOC L2 user to assign.' });
    }
    const data = await sm.assignL3ToL2({
      leadId: req.params.id,
      actor: actorFromReq(req),
      assignedToId,
      notes: asText(req.body?.notes),
    });
    return res.json({ message: 'Handoff assigned.', data });
  } catch (error) {
    return fail(res, error);
  }
};

/** POST /api/leads/:id/client-handover (SALES) { notes? } */
export const completeClientHandover = async (req, res) => {
  try {
    const data = await sm.completeClientHandover({
      leadId: req.params.id,
      actor: actorFromReq(req),
      notes: asText(req.body?.notes),
    });
    return res.json({ message: 'Client handover recorded.', data });
  } catch (error) {
    return fail(res, error);
  }
};

/** POST /api/leads/:id/agreement/sent-for-signature (SOFTWARE) */
export const markAgreementSentForSignature = async (req, res) => {
  try {
    const data = await sm.markAgreementSentForSignature({
      leadId: req.params.id,
      actor: actorFromReq(req),
    });
    return res.json({ message: 'Marked as sent to the operator for signature.', data });
  } catch (error) {
    return fail(res, error);
  }
};

/** POST /api/leads/:id/verify-agreement (SOFTWARE) */
export const verifyAgreement = async (req, res) => {
  try {
    const data = await sm.verifyAgreement({ leadId: req.params.id, actor: actorFromReq(req) });
    return res.json({ message: 'Agreement verified — lead completed.', data });
  } catch (error) {
    return fail(res, error);
  }
};
