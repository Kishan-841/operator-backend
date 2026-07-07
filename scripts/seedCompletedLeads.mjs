/**
 * Seed 5 fully-COMPLETED leads (all four categories, Pune coordinates) by
 * walking each one through the REAL state machine — every transition, audit
 * row, note, material requisition, dispatch and config is produced exactly as
 * if users had clicked through the app. Completion dates are then spread over
 * recent months so the dashboard revenue/growth charts have shape.
 *
 * Run: node scripts/seedCompletedLeads.mjs
 */
import prisma from '../src/config/db.js';
import * as sm from '../src/services/leadStateMachine.js';
import { generateLeadNumber } from '../src/services/leadNumber.service.js';

const bank = { accountName: 'Operator A/C', accountNumber: '50100011223344', ifsc: 'HDFC0000001', bankName: 'HDFC Bank' };

// Real Pune-area coordinates, one per lead.
const SEEDS = [
  {
    org: 'Deccan Broadband', category: 'PIN_RATE', monthsAgo: 5,
    lat: 18.5074, lng: 73.8077, area: 'Kothrud', pin: '411038',
    req: { estimatedUserCount: 1200, ratePerUser: 45, existingISP: { companyName: 'Skyline Net' }, customerInterestLevel: 'HOT' },
    rate: 54000,
  },
  {
    org: 'Mula-Mutha Networks', category: 'JV', monthsAgo: 4,
    lat: 18.559, lng: 73.7868, area: 'Baner', pin: '411045',
    req: { userCount: 3000, percentageSplit: 60, bankDetails: bank, scopeOfWork: 'Joint fiber rollout across Baner-Balewadi' },
    rate: 150000,
  },
  {
    org: 'Shaniwar Peth Telecom', category: 'REVENUE_SHARING', monthsAgo: 3,
    lat: 18.5308, lng: 73.8478, area: 'Shivajinagar', pin: '411005',
    req: { userCount: 900, rateType: 'PERCENTAGE', percentageSplit: 45, bankDetails: bank, scopeOfWork: 'Revenue share on existing plant' },
    rate: 90000,
  },
  {
    org: 'Hinjewadi IX', category: 'ISP', monthsAgo: 2,
    lat: 18.5913, lng: 73.7389, area: 'Hinjewadi Phase 1', pin: '411057',
    req: { asNumber: 141234, bandwidthMix: ['PEERING', 'ILL'], bandwidthSpecs: { PEERING: { value: 10, unit: 'GB' }, ILL: { value: 1, unit: 'GB' } } },
    rate: 175000,
  },
  {
    org: 'Hadapsar FiberNet', category: 'PIN_RATE', monthsAgo: 1,
    lat: 18.5089, lng: 73.926, area: 'Hadapsar', pin: '411028',
    req: { estimatedUserCount: 800, ratePerUser: 40, existingISP: { companyName: 'CityCable' }, customerInterestLevel: 'WARM' },
    rate: 32000,
  },
];

const userByRole = async (role) => {
  const u = await prisma.user.findFirst({ where: { role, isActive: true }, orderBy: { createdAt: 'asc' } });
  if (!u) throw new Error(`No active ${role} user — run the user seed first.`);
  return { id: u.id, role: u.role, label: u.email };
};

const run = async () => {
  const [sales, feasibility, admin, software, delivery, store, nocL2, nocL3] = await Promise.all(
    ['SALES_USER', 'FEASIBILITY_USER', 'ADMIN', 'SOFTWARE_USER', 'DELIVERY_USER', 'STORE_USER', 'NOC_L2_USER', 'NOC_L3_USER'].map(userByRole),
  );

  // One serialized product + a stocked PO with enough serials for every lead.
  let product = await prisma.storeProduct.findFirst({ where: { isActive: true, unit: 'pcs' } });
  if (!product) {
    product = await prisma.storeProduct.create({
      data: { category: 'SWITCH', modelNumber: 'C9200-SEED', brandName: 'Cisco', price: 45000, createdById: store.id },
    });
  }
  const serials = SEEDS.map((_, i) => `PUNE-SN-${String(i + 1).padStart(3, '0')}`);
  const po = await prisma.storePurchaseOrder.create({
    data: {
      poNumber: `PO-SEED-${Date.now()}`,
      status: 'COMPLETED', // fully received
      createdById: store.id,
      adminApprovedById: admin.id,
      adminApprovedAt: new Date(),
      items: {
        create: [{
          productId: product.id,
          quantity: serials.length,
          unitPrice: 45000,
          serialNumbers: serials,
          receivedQuantity: serials.length,
          stockedQuantity: serials.length,
          status: 'IN_STORE',
          addedToStoreAt: new Date(),
        }],
      },
    },
    include: { items: true },
  });
  const poItem = po.items[0];
  console.log(`stock   ${po.poNumber} → ${serials.length} × ${product.modelNumber}`);

  for (let i = 0; i < SEEDS.length; i += 1) {
    const s = SEEDS[i];

    // 1. Create (sales-owned, Pune coords + values).
    const lead = await prisma.$transaction(async (tx) => {
      const leadNumber = await generateLeadNumber(tx);
      return tx.lead.create({
        data: {
          leadNumber,
          category: s.category,
          requirementDetails: s.req,
          organizationName: s.org,
          email: `ops@${s.org.toLowerCase().replace(/[^a-z]+/g, '')}.example`,
          contactPersonName: 'Ops Head',
          phone: `98220${String(11000 + i * 111).slice(0, 5)}`,
          whatsappNumber: `98220${String(11000 + i * 111).slice(0, 5)}`,
          areaName: `${s.area} Exchange`,
          city: 'Pune',
          state: 'Maharashtra',
          pincode: s.pin,
          latitude: s.lat,
          longitude: s.lng,
          territory: `${s.area}, Pune · ${s.pin}`,
          customerInterestLevel: 'HOT',
          status: 'NEW',
          createdById: sales.id,
          assignedSalesId: sales.id,
        },
        select: { id: true, leadNumber: true },
      });
    });

    // 2–4. Feasibility → pricing → approval.
    await sm.submitForFeasibility({ leadId: lead.id, actor: sales });
    await sm.completeFeasibility({
      leadId: lead.id,
      actor: feasibility,
      feasible: true,
      notes: `On-net, ${s.area} ring has spare capacity`,
      vendors: [{ kind: 'OWN', fiberMeters: 400 + i * 150 }],
      latitude: s.lat,
      longitude: s.lng,
      networkType: 'ON_NET',
    });
    await sm.submitPricing({ leadId: lead.id, actor: sales, pricing: { ratePerMonth: s.rate } });
    await sm.approveLead({ leadId: lead.id, actor: admin });

    // 5. Docs: upload → send for verification → software approves → complete.
    const doc = await prisma.leadDocument.create({
      data: { leadId: lead.id, type: 'GST Certificate', fileName: 'gst-certificate.pdf', storageKey: `seed/${lead.leadNumber}/gst.pdf`, uploadedById: sales.id },
    });
    await sm.submitDocsForVerification({ leadId: lead.id, actor: sales });
    await prisma.leadDocument.update({
      where: { id: doc.id },
      data: { salesApprovedAt: new Date(), salesApprovedById: software.id },
    });
    await sm.completeDocs({ leadId: lead.id, actor: software });

    // 6–8. Material requisition → admin approval → store assigns a serial.
    await sm.submitMaterialReq({ leadId: lead.id, actor: delivery, items: [{ productId: product.id, quantity: 1 }] });
    await sm.approveMaterialRequest({ leadId: lead.id, actor: admin });
    const dr = await prisma.deliveryRequest.findUnique({ where: { leadId: lead.id }, include: { items: true } });
    await sm.assignMaterial({
      leadId: lead.id,
      actor: store,
      assignments: [{ itemId: dr.items[0].id, sources: [{ poItemId: poItem.id, serialNumbers: [serials[i]] }] }],
    });

    // 9–15. Installation → NOC L2 → aggregator → software → NOC L3 → handoff → handover.
    await sm.completeInstallation({ leadId: lead.id, actor: delivery, notes: 'Installed & patched' });
    await sm.completeNocL2({ leadId: lead.id, actor: nocL2, configNotes: 'VLAN + uplink configured; OPM/DUDE/CACTI added' });
    await sm.confirmAggregator({ leadId: lead.id, actor: sales, aggregatorType: i % 2 ? 'MIKROTIK' : 'BNG', remark: 'Confirmed with client' });
    await sm.completeSoftware({ leadId: lead.id, actor: software, managedBy: 'SOFTWARE', portalUsername: s.org.toLowerCase().replace(/[^a-z]+/g, '') });
    // ISP leads skip NOC L3 + the L3→L2 handoff (software sends them straight
    // to client handover); every other category walks both.
    if (s.category !== 'ISP') {
      await sm.completeNocL3({ leadId: lead.id, actor: nocL3, ipAllocation: { subnet: `10.7.${i + 1}.0/24`, gateway: `10.7.${i + 1}.1`, vlanId: 700 + i } });
      await sm.completeL3ToL2({ leadId: lead.id, actor: nocL2, notes: 'Handoff verified' });
    }
    await sm.completeClientHandover({ leadId: lead.id, actor: sales, notes: 'Client walked through the portal' });

    // 16. Required docs (agreement close-out enforces the full per-category
    // list) + the signed agreement → verify → COMPLETED.
    const { requiredDocsFor } = await import('../src/utils/docRequirements.js');
    for (const type of requiredDocsFor(s.category)) {
      if (type === 'GST Certificate') continue; // uploaded at the docs stage above
      await prisma.leadDocument.create({
        data: { leadId: lead.id, type, fileName: `${type.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.pdf`, storageKey: `seed/${lead.leadNumber}/${type}.pdf`, uploadedById: sales.id },
      });
    }
    await prisma.leadDocument.create({
      data: { leadId: lead.id, type: 'AGREEMENT', fileName: 'signed-agreement.pdf', storageKey: `seed/${lead.leadNumber}/agreement.pdf`, uploadedById: software.id },
    });
    await sm.verifyAgreement({ leadId: lead.id, actor: software });

    // Spread onboarding over recent months so revenue growth has a curve.
    const onboardedAt = new Date();
    onboardedAt.setMonth(onboardedAt.getMonth() - s.monthsAgo);
    await prisma.statusChangeLog.updateMany({
      where: { entityId: lead.id, newValue: 'COMPLETED' },
      data: { createdAt: onboardedAt },
    });

    const final = await prisma.lead.findUnique({ where: { id: lead.id }, select: { status: true } });
    console.log(`lead    ${lead.leadNumber}  ${s.org.padEnd(24)} ${s.category.padEnd(16)} → ${final.status}  (onboarded ${onboardedAt.toISOString().slice(0, 10)})`);
  }

  console.log('done — 5 Pune operators walked NEW → COMPLETED through the full pipeline.');
};

run()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
