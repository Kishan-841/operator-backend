import { generateLeadNumber } from './leadNumber.service.js';

// Dual-role support (distributor-feature): a business can be both a Distributor
// and a Franchise (= Lead), linked via lead.distributorId. Both helpers run
// inside the caller's transaction so the pair is created atomically, and both
// REUSE an existing counterpart rather than creating a duplicate.

const contactOr = ({ email, phone }) => {
  const or = [];
  if (email) or.push({ email: { equals: email, mode: 'insensitive' } });
  if (phone) or.push({ phone });
  return or;
};

const findLeadByContact = async (tx, contact) => {
  const or = contactOr(contact);
  if (!or.length) return null;
  // REJECTED leads don't count — a turned-down franchise may legitimately recur.
  return tx.lead.findFirst({
    where: { status: { not: 'REJECTED' }, OR: or },
    select: { id: true, distributorId: true },
  });
};

const findDistributorByContact = async (tx, contact) => {
  const or = contactOr(contact);
  if (!or.length) return null;
  return tx.distributor.findFirst({ where: { OR: or }, select: { id: true } });
};

/**
 * Ensure the distributor's business also exists as a franchise-lead linked to it.
 * Reuses an existing (non-REJECTED) lead for the same contact — just linking it —
 * or creates a new NEW lead from the distributor's stored profile (metrics may be
 * empty for PIN_RATE; sales fills them later). Returns the lead id.
 */
export const ensureFranchiseLead = async (tx, { distributor, profile, actorId }) => {
  const contact = { email: profile.email, phone: profile.phone };
  const existing = await findLeadByContact(tx, contact);
  if (existing) {
    if (existing.distributorId !== distributor.id) {
      await tx.lead.update({ where: { id: existing.id }, data: { distributorId: distributor.id } });
    }
    return existing.id;
  }
  const leadNumber = await generateLeadNumber(tx);
  const created = await tx.lead.create({
    data: {
      ...profile,
      requirementDetails: profile.requirementDetails ?? {},
      leadNumber,
      distributorId: distributor.id,
      status: 'NEW',
      createdById: actorId,
      assignedSalesId: actorId,
    },
  });
  return created.id;
};

/**
 * Ensure the lead's business also exists as a distributor. Reuses an existing
 * distributor for the same contact (returning its id) or creates one from the
 * lead payload (stored as its profile). Returns the distributor id — the caller
 * sets it as the lead's distributorId to link them.
 */
export const ensureDistributorForLead = async (tx, { contact, payload, actorId }) => {
  const existing = await findDistributorByContact(tx, contact);
  if (existing) return existing.id;
  const email = String(payload.email || '').trim().toLowerCase() || null;
  const created = await tx.distributor.create({
    data: { name: payload.organizationName, phone: payload.phone || null, email, profile: payload },
  });
  return created.id;
};
