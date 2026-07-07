/**
 * Ensure every pipeline queue has at least one lead so the whole flow is
 * demoable. Idempotent — for each queue status, only creates a lead if that
 * status currently has none. Also guarantees the Docs Verification work-view
 * (a SOFTWARE_PENDING lead carrying an unverified document).
 * Run: node scripts/seedQueueCoverage.mjs
 */
import prisma from '../src/config/db.js';
import { generateLeadNumber } from '../src/services/leadNumber.service.js';

const bank = { accountName: 'Operator A/C', accountNumber: '50100099887766', ifsc: 'HDFC0000001', bankName: 'HDFC Bank' };
const reqFor = (kind) => {
  switch (kind) {
    case 'PIN_RATE': return { category: 'PIN_RATE', requirementDetails: { estimatedUserCount: 1000, ratePerUser: 38 } };
    case 'JV': return { category: 'JV', requirementDetails: { userCount: 2500, percentageSplit: 55, bankDetails: bank } };
    case 'RS_PCT': return { category: 'REVENUE_SHARING', requirementDetails: { userCount: 900, rateType: 'PERCENTAGE', percentageSplit: 42, bankDetails: bank } };
    case 'RS_FIXED': return { category: 'REVENUE_SHARING', requirementDetails: { userCount: 1100, rateType: 'FIXED', fixedRate: 60000, bankDetails: bank } };
    case 'ISP': return { category: 'ISP', requirementDetails: { bandwidthMix: ['PEERING', 'ILL'] }, annualRevenue: 25000000 };
    default: throw new Error('bad kind');
  }
};

// One operator per queue status. Real coordinates, varied categories.
const SEEDS = [
  { status: 'FEASIBILITY_PENDING', kind: 'PIN_RATE', org: 'Aravalli Broadband', contact: 'Rohit Sharma', phone: '9610011223', city: 'Jaipur', state: 'Rajasthan', lat: 26.9124, lng: 75.7873, pin: '302001', office: 'MI Road', rate: 38000 },
  { status: 'PRICING_PENDING', kind: 'JV', org: 'Sabarmati Telecom', contact: 'Nikhil Patel', phone: '9879011223', city: 'Ahmedabad', state: 'Gujarat', lat: 23.0225, lng: 72.5714, pin: '380009', office: 'Navrangpura', rate: 120000 },
  { status: 'PENDING_APPROVAL', kind: 'ISP', org: 'Pink City Peering', contact: 'Anjali Verma', phone: '9610044556', city: 'Jaipur', state: 'Rajasthan', lat: 26.9239, lng: 75.8267, pin: '302016', office: 'Malviya Nagar', rate: 150000 },
  { status: 'APPROVED', kind: 'PIN_RATE', org: 'Riverfront Net', contact: 'Hardik Shah', phone: '9879044556', city: 'Ahmedabad', state: 'Gujarat', lat: 23.0469, lng: 72.5800, pin: '380006', office: 'Ellisbridge', rate: 44000 },
  { status: 'DELIVERY_REQ_PENDING', kind: 'JV', org: 'Diamond City Fibre', contact: 'Mitesh Desai', phone: '9825011223', city: 'Surat', state: 'Gujarat', lat: 21.1702, lng: 72.8311, pin: '395003', office: 'Athwa', rate: 130000 },
  { status: 'AWAITING_DISPATCH', kind: 'RS_PCT', org: 'Malwa Connect', contact: 'Priya Jain', phone: '9826011223', city: 'Indore', state: 'Madhya Pradesh', lat: 22.7196, lng: 75.8577, pin: '452001', office: 'MG Road', rate: 58000 },
  { status: 'DISPATCHED', kind: 'PIN_RATE', org: 'Lake City Broadband', contact: 'Aditya Soni', phone: '9826044556', city: 'Bhopal', state: 'Madhya Pradesh', lat: 23.2599, lng: 77.4126, pin: '462001', office: 'MP Nagar', rate: 41000 },
  { status: 'AGGREGATOR_CONFIRM_PENDING', kind: 'ISP', org: 'Awadh Bandwidth', contact: 'Saurabh Singh', phone: '9621011223', city: 'Lucknow', state: 'Uttar Pradesh', lat: 26.8467, lng: 80.9462, pin: '226001', office: 'Hazratganj', rate: 170000 },
  { status: 'NOC_L3_PENDING', kind: 'JV', org: 'Ganga Telecom', contact: 'Rakesh Kumar', phone: '9631011223', city: 'Patna', state: 'Bihar', lat: 25.5941, lng: 85.1376, pin: '800001', office: 'Gandhi Maidan', rate: 135000 },
  { status: 'L3_TO_L2_HANDOFF', kind: 'PIN_RATE', org: 'Chhotanagpur Net', contact: 'Deepak Oraon', phone: '9631044556', city: 'Ranchi', state: 'Jharkhand', lat: 23.3441, lng: 85.3096, pin: '834001', office: 'Lalpur', rate: 39000 },
  { status: 'CLIENT_HANDOVER_PENDING', kind: 'RS_FIXED', org: 'Naya Raipur Digital', contact: 'Sunil Sahu', phone: '9826077889', city: 'Raipur', state: 'Chhattisgarh', lat: 21.2514, lng: 81.6296, pin: '492001', office: 'Pandri', rate: 60000 },
  { status: 'AGREEMENT_PENDING', kind: 'ISP', org: 'Vizag Bandwidth Exchange', contact: 'Lakshmi Rao', phone: '9848011223', city: 'Visakhapatnam', state: 'Andhra Pradesh', lat: 17.6868, lng: 83.2185, pin: '530002', office: 'Dwaraka Nagar', rate: 165000 },
];

const run = async () => {
  const sales = await prisma.user.findFirst({ where: { role: 'SALES_USER' }, orderBy: { createdAt: 'asc' } });
  const nocL2 = await prisma.user.findFirst({ where: { role: 'NOC_L2_USER' }, orderBy: { createdAt: 'asc' } });
  if (!sales) throw new Error('No SALES_USER found — run `node prisma/seed.js` first.');

  // Fix the orphaned DOCS_PENDING lead — no queue lists that status. Move it to
  // APPROVED so it surfaces in the Docs Queue.
  const orphan = await prisma.lead.updateMany({ where: { status: 'DOCS_PENDING' }, data: { status: 'APPROVED' } });
  if (orphan.count) console.log(`  fixed  ${orphan.count} DOCS_PENDING lead(s) → APPROVED`);

  let created = 0;
  let skipped = 0;
  for (const s of SEEDS) {
    const existing = await prisma.lead.count({ where: { status: s.status } });
    if (existing > 0) {
      console.log(`  skip   ${s.status.padEnd(26)} (already ${existing})`);
      skipped += 1;
      continue;
    }
    const r = reqFor(s.kind);
    const lead = await prisma.$transaction(async (tx) => {
      const leadNumber = await generateLeadNumber(tx);
      return tx.lead.create({
        data: {
          leadNumber,
          category: r.category,
          requirementDetails: r.requirementDetails,
          ...(r.annualRevenue ? { annualRevenue: r.annualRevenue } : {}),
          organizationName: s.org,
          email: `ops@${s.org.toLowerCase().replace(/[^a-z]+/g, '')}.example`,
          contactPersonName: s.contact,
          phone: s.phone,
          whatsappNumber: s.phone,
          areaName: `${s.office} Tower`,
          city: s.city,
          state: s.state,
          latitude: s.lat,
          longitude: s.lng,
          territory: `${s.office}, ${s.city} · ${s.pin}`,
          customerInterestLevel: 'WARM',
          pricing: { ratePerMonth: s.rate },
          status: s.status,
          createdById: sales.id,
          assignedSalesId: sales.id,
          // L3→L2 handoff is assigned to a NOC L2 user (admins see all anyway).
          ...(s.status === 'L3_TO_L2_HANDOFF' && nocL2 ? { l3ToL2AssignedToId: nocL2.id } : {}),
        },
        select: { id: true, leadNumber: true },
      });
    });
    console.log(`  create ${s.status.padEnd(26)} ${lead.leadNumber}  ${s.org}`);
    created += 1;
  }

  // Docs Verification work-view: a SOFTWARE_PENDING lead with an unverified doc.
  const docVer = await prisma.lead.count({
    where: { status: 'SOFTWARE_PENDING', documents: { some: { verificationStatus: { not: 'VERIFIED' } } } },
  });
  if (docVer === 0) {
    const swLead = await prisma.lead.findFirst({ where: { status: 'SOFTWARE_PENDING' }, select: { id: true, leadNumber: true } });
    if (swLead) {
      await prisma.leadDocument.create({
        data: {
          leadId: swLead.id,
          type: 'AGREEMENT',
          label: 'Service agreement',
          fileName: 'agreement-draft.pdf',
          storageKey: `leads/${swLead.leadNumber}/AGREEMENT/agreement-draft.pdf`,
          mimeType: 'application/pdf',
          verificationStatus: 'PENDING',
        },
      });
      console.log(`  doc    Docs Verification → attached PENDING doc to ${swLead.leadNumber}`);
    } else {
      console.log('  warn   no SOFTWARE_PENDING lead to attach a doc to');
    }
  } else {
    console.log(`  skip   Docs Verification (already ${docVer})`);
  }

  console.log(`\nDone. ${created} created, ${skipped} skipped.`);
};

run()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
