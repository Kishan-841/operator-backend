/**
 * Wipe all lead data, keeping users, POP locations, pincodes/territory data,
 * vendors, and document types. Resets the lead-number counter to OPC-0001.
 *
 * Deletes: Lead (cascades LeadNote, LeadDocument, MaterialRequisition, Dispatch),
 *          lead-linked Notifications, lead StatusChangeLog entries, LEAD counter.
 * Keeps:   User, PopLocation, Pincode, Vendor, DocumentType.
 *
 * Run: node scripts/wipeLeads.mjs
 */
import prisma from '../src/config/db.js';

const run = async () => {
  const before = {
    leads: await prisma.lead.count(),
    notifications: await prisma.notification.count(),
    leadLogs: await prisma.statusChangeLog.count({ where: { entityType: 'Lead' } }),
  };
  console.log('Before:', before);

  const result = await prisma.$transaction(async (tx) => {
    // Notifications + lead audit have no FK cascade — clear them explicitly.
    const notifications = await tx.notification.deleteMany({ where: { leadId: { not: null } } });
    const leadLogs = await tx.statusChangeLog.deleteMany({ where: { entityType: 'Lead' } });
    // Deleting leads cascades to LeadNote / LeadDocument / MaterialRequisition / Dispatch.
    const leads = await tx.lead.deleteMany({});
    // Drop the LEAD counter so the next lead generates OPC-0001.
    const counter = await tx.counter.deleteMany({ where: { key: 'LEAD' } });
    return { leads, notifications, leadLogs, counter };
  });

  console.log('Deleted:', {
    leads: result.leads.count,
    notifications: result.notifications.count,
    leadLeadLogs: result.leadLogs.count,
    counterReset: result.counter.count > 0,
  });

  const kept = {
    users: await prisma.user.count(),
    popLocations: await prisma.popLocation.count(),
    pincodes: await prisma.pincode.count(),
    vendors: await prisma.vendor.count(),
    documentTypes: await prisma.documentType.count(),
  };
  console.log('Kept:', kept);
};

run()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
