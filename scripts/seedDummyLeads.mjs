/**
 * Seed dummy operators — 2–3 per category (PIN_RATE, JV, REVENUE_SHARING, ISP)
 * with real coordinates, pricing, and varied statuses. A few are COMPLETED (with
 * a back-dated onboarding audit entry) so converted + revenue metrics show data.
 * Idempotent — skips a category sample if its org already exists.
 * Run: node scripts/seedDummyLeads.mjs
 */
import prisma from '../src/config/db.js';
import { generateLeadNumber } from '../src/services/leadNumber.service.js';

const monthsAgo = (n) => {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d;
};

const bank = (accountName, accountNumber, ifsc, bankName) => ({ accountName, accountNumber, ifsc, bankName });

// onboardedMonthsAgo set ⇒ lead is COMPLETED and onboarded that long ago.
const SAMPLES = [
  // ── PIN_RATE ──────────────────────────────────────────────
  {
    category: 'PIN_RATE', organizationName: 'Skyline Broadband Pvt Ltd', email: 'noc@skylinebroadband.example',
    contactPersonName: 'Rahul Mehta', phone: '9820011234', whatsappNumber: '9820011234',
    areaName: 'Amar Tech Park', city: 'Pune', state: 'Maharashtra', territory: 'Hinjewadi B.O, Pune · 411057',
    latitude: 18.5912, longitude: 73.7389, customerInterestLevel: 'HOT',
    requirementDetails: { estimatedUserCount: 1500, ratePerUser: 35 },
    pricing: { ratePerMonth: 52500, finalPrice: 50000 }, onboardedMonthsAgo: 5,
  },
  {
    category: 'PIN_RATE', organizationName: 'Metro Connect Networks', email: 'ops@metroconnect.example',
    contactPersonName: 'Sneha Kulkarni', phone: '9890044556', whatsappNumber: '9890044556',
    areaName: 'Empress Tower', city: 'Nagpur', state: 'Maharashtra', territory: 'Sitabuldi, Nagpur · 440012',
    latitude: 21.1458, longitude: 79.0882, customerInterestLevel: 'WARM', status: 'FEASIBILITY_PENDING',
    requirementDetails: { estimatedUserCount: 800, ratePerUser: 40 }, pricing: { ratePerMonth: 32000 },
  },
  {
    category: 'PIN_RATE', organizationName: 'Sahyadri Net', email: 'biz@sahyadrinet.example',
    contactPersonName: 'Amit Pawar', phone: '9011223344', whatsappNumber: '9011223344',
    areaName: 'Grape County Plaza', city: 'Nashik', state: 'Maharashtra', territory: 'Nashik Road, Nashik · 422101',
    latitude: 19.9975, longitude: 73.7898, customerInterestLevel: 'WARM', status: 'PRICING_PENDING',
    requirementDetails: { estimatedUserCount: 2200, ratePerUser: 30 }, pricing: { ratePerMonth: 66000 },
  },

  // ── JV ────────────────────────────────────────────────────
  {
    category: 'JV', organizationName: 'Northwind Telecom LLP', email: 'partners@northwindtel.example',
    contactPersonName: 'Aisha Khan', phone: '9711122334', whatsappNumber: '9711122334',
    areaName: 'Cyber Greens', city: 'Gurugram', state: 'Haryana', territory: 'DLF Phase III, Gurugram · 122002',
    latitude: 28.4595, longitude: 77.0266, customerInterestLevel: 'HOT',
    requirementDetails: { userCount: 4200, percentageSplit: 60, bankDetails: bank('Northwind Telecom LLP', '50100234567890', 'HDFC0001234', 'HDFC Bank') },
    pricing: { ratePerMonth: 180000, finalPrice: 175000 }, onboardedMonthsAgo: 2,
  },
  {
    category: 'JV', organizationName: 'Deccan Fibre Partners', email: 'jv@deccanfibre.example',
    contactPersonName: 'Vikram Reddy', phone: '9849011223', whatsappNumber: '9849011223',
    areaName: 'Mindspace Block C', city: 'Hyderabad', state: 'Telangana', territory: 'Madhapur, Hyderabad · 500081',
    latitude: 17.4485, longitude: 78.3908, customerInterestLevel: 'WARM', status: 'NOC_L2_PENDING',
    requirementDetails: { userCount: 3000, percentageSplit: 50, bankDetails: bank('Deccan Fibre Partners', '60201122334455', 'ICIC0006021', 'ICICI Bank') },
    pricing: { ratePerMonth: 140000 },
  },

  // ── REVENUE_SHARING ───────────────────────────────────────
  {
    category: 'REVENUE_SHARING', organizationName: 'Coastal Net Services', email: 'biz@coastalnet.example',
    contactPersonName: 'Vivek Nair', phone: '9847055667', whatsappNumber: '9847055667',
    areaName: 'Marine Drive Arcade', city: 'Kochi', state: 'Kerala', territory: 'Ernakulam, Kochi · 682011',
    latitude: 9.9816, longitude: 76.2999, customerInterestLevel: 'WARM',
    requirementDetails: { userCount: 800, rateType: 'PERCENTAGE', percentageSplit: 45, bankDetails: bank('Coastal Net Services', '38291100456712', 'SBIN0009876', 'State Bank of India') },
    pricing: { ratePerMonth: 64000 },
  },
  {
    category: 'REVENUE_SHARING', organizationName: 'Konkan Digital', email: 'ops@konkandigital.example',
    contactPersonName: 'Pooja Shenoy', phone: '9844066778', whatsappNumber: '9844066778',
    areaName: 'Empire Mall Tower', city: 'Mangaluru', state: 'Karnataka', territory: 'Hampankatta, Mangaluru · 575001',
    latitude: 12.8703, longitude: 74.8430, customerInterestLevel: 'COLD', status: 'DOCS_PENDING',
    requirementDetails: { userCount: 1200, rateType: 'FIXED', fixedRate: 75000, bankDetails: bank('Konkan Digital', '11220033445566', 'KKBK0008012', 'Kotak Mahindra Bank') },
    pricing: { ratePerMonth: 75000 },
  },
  {
    category: 'REVENUE_SHARING', organizationName: 'Eastern Broadband Co', email: 'noc@easternbroadband.example',
    contactPersonName: 'Subhash Patnaik', phone: '9438077889', whatsappNumber: '9438077889',
    areaName: 'Janpath Square', city: 'Bhubaneswar', state: 'Odisha', territory: 'Saheed Nagar, Bhubaneswar · 751007',
    latitude: 20.2961, longitude: 85.8245, customerInterestLevel: 'WARM',
    requirementDetails: { userCount: 600, rateType: 'PERCENTAGE', percentageSplit: 40, bankDetails: bank('Eastern Broadband Co', '99887766554433', 'UTIB0000123', 'Axis Bank') },
    pricing: { ratePerMonth: 48000, finalPrice: 45000 }, onboardedMonthsAgo: 1,
  },

  // ── ISP ───────────────────────────────────────────────────
  {
    category: 'ISP', organizationName: 'Apex Bandwidth Co', email: 'ops@apexbandwidth.example',
    contactPersonName: 'Sanjana Rao', phone: '9900123456', whatsappNumber: '9900123456',
    areaName: 'UB City Tower', city: 'Bengaluru', state: 'Karnataka', territory: 'Vittal Mallya Road, Bengaluru · 560001',
    latitude: 12.9716, longitude: 77.5946, annualRevenue: 75000000, customerInterestLevel: 'HOT',
    requirementDetails: { bandwidthMix: ['PEERING', 'ILL', 'AKAMAI'] },
    pricing: { ratePerMonth: 240000, finalPrice: 230000 }, onboardedMonthsAgo: 3,
  },
  {
    category: 'ISP', organizationName: 'Gigabit Exchange', email: 'peering@gigabitexchange.example',
    contactPersonName: 'Karthik Iyer', phone: '9840098765', whatsappNumber: '9840098765',
    areaName: 'Olympia Tech Park', city: 'Chennai', state: 'Tamil Nadu', territory: 'Guindy, Chennai · 600032',
    latitude: 13.0102, longitude: 80.2120, annualRevenue: 30000000, customerInterestLevel: 'WARM', status: 'SOFTWARE_PENDING',
    requirementDetails: { bandwidthMix: ['PEERING', 'P2P'] }, pricing: { ratePerMonth: 160000 },
  },
];

const run = async () => {
  const sales = await prisma.user.findFirst({ where: { role: 'SALES_USER' }, orderBy: { createdAt: 'asc' } });
  if (!sales) throw new Error('No SALES_USER found — run `node prisma/seed.js` first.');

  let created = 0;
  let skipped = 0;
  for (const s of SAMPLES) {
    const exists = await prisma.lead.findFirst({ where: { organizationName: s.organizationName }, select: { leadNumber: true } });
    if (exists) {
      console.log(`  skip   ${s.category.padEnd(16)} ${s.organizationName} (already ${exists.leadNumber})`);
      skipped += 1;
      continue;
    }

    const { category, requirementDetails, pricing, onboardedMonthsAgo, status, ...contact } = s;
    const finalStatus = onboardedMonthsAgo != null ? 'COMPLETED' : (status || 'NEW');

    const lead = await prisma.$transaction(async (tx) => {
      const leadNumber = await generateLeadNumber(tx);
      const row = await tx.lead.create({
        data: {
          leadNumber, category, requirementDetails, pricing, ...contact,
          status: finalStatus, createdById: sales.id, assignedSalesId: sales.id,
        },
        select: { id: true, leadNumber: true, organizationName: true },
      });
      // Back-date onboarding so revenue/growth spreads across months.
      if (onboardedMonthsAgo != null) {
        await tx.statusChangeLog.create({
          data: {
            action: 'STATUS_CHANGED', entityType: 'Lead', entityId: row.id,
            oldValue: 'AGREEMENT_PENDING', newValue: 'COMPLETED',
            summary: `${row.leadNumber} marked COMPLETED`, changedById: sales.id,
            createdAt: monthsAgo(onboardedMonthsAgo),
          },
        });
      }
      return row;
    });

    console.log(`  create ${category.padEnd(16)} ${s.organizationName} → ${lead.leadNumber} (${finalStatus})`);
    created += 1;
  }

  console.log(`\nDone. ${created} created, ${skipped} skipped.`);
  const byCat = await prisma.lead.groupBy({ by: ['category'], _count: { _all: true } });
  console.log('Leads per category:', Object.fromEntries(byCat.map((c) => [c.category, c._count._all])));
};

run()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
