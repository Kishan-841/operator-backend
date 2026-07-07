/**
 * Seed one sample lead per category (PIN_RATE, JV, REVENUE_SHARING, ISP) so the
 * admin dashboard's "Leads by category" cards have data to show.
 * Idempotent — skips a category if its sample org already exists.
 * Run: node scripts/seedSampleLeads.mjs
 */
import prisma from '../src/config/db.js';
import { generateLeadNumber } from '../src/services/leadNumber.service.js';

// requirementDetails shapes must satisfy backend/src/validation/leadCategories.js.
// `pricing.ratePerMonth` feeds the dashboard avg-value metric (monthlyValueOf).
const SAMPLES = [
  {
    category: 'PIN_RATE',
    organizationName: 'Skyline Broadband Pvt Ltd',
    email: 'noc@skylinebroadband.example',
    contactPersonName: 'Rahul Mehta',
    phone: '9820011234',
    whatsappNumber: '9820011234',
    territory: 'Maharashtra',
    city: 'Pune',
    state: 'Maharashtra',
    annualRevenue: 12000000,
    customerInterestLevel: 'HOT',
    requirementDetails: {
      estimatedUserCount: 1500,
      ratePerUser: 35,
      existingISP: { companyName: 'Local Fibernet' },
    },
    pricing: { ratePerMonth: 52500 },
  },
  {
    category: 'JV',
    organizationName: 'Northwind Telecom LLP',
    email: 'partners@northwindtel.example',
    contactPersonName: 'Aisha Khan',
    phone: '9711122334',
    whatsappNumber: '9711122334',
    territory: 'Delhi NCR',
    city: 'Gurugram',
    state: 'Haryana',
    annualRevenue: 48000000,
    customerInterestLevel: 'WARM',
    requirementDetails: {
      userCount: 4200,
      percentageSplit: 60,
      bankDetails: {
        accountName: 'Northwind Telecom LLP',
        accountNumber: '50100234567890',
        ifsc: 'HDFC0001234',
        bankName: 'HDFC Bank',
      },
      scopeOfWork: 'Co-invest in last-mile fibre across 3 sub-districts; revenue split 60/40.',
    },
    pricing: { ratePerMonth: 180000 },
  },
  {
    category: 'REVENUE_SHARING',
    organizationName: 'Coastal Net Services',
    email: 'biz@coastalnet.example',
    contactPersonName: 'Vivek Nair',
    phone: '9847055667',
    whatsappNumber: '9847055667',
    territory: 'Kerala',
    city: 'Kochi',
    state: 'Kerala',
    annualRevenue: 9000000,
    customerInterestLevel: 'WARM',
    requirementDetails: {
      userCount: 800,
      percentageSplit: 45,
      bankDetails: {
        accountName: 'Coastal Net Services',
        accountNumber: '38291100456712',
        ifsc: 'SBIN0009876',
        bankName: 'State Bank of India',
      },
      scopeOfWork: 'Revenue-share on hosted subscriber base; no upfront co-investment.',
    },
    pricing: { ratePerMonth: 64000 },
  },
  {
    category: 'ISP',
    organizationName: 'Apex Bandwidth Co',
    email: 'ops@apexbandwidth.example',
    contactPersonName: 'Sanjana Rao',
    phone: '9900123456',
    whatsappNumber: '9900123456',
    territory: 'Karnataka',
    city: 'Bengaluru',
    state: 'Karnataka',
    annualRevenue: 75000000,
    customerInterestLevel: 'HOT',
    requirementDetails: {
      bandwidthMix: ['PEERING', 'ILL', 'AKAMAI'],
    },
    pricing: { ratePerMonth: 240000 },
  },
];

const run = async () => {
  const sales = await prisma.user.findFirst({
    where: { role: 'SALES_USER' },
    orderBy: { createdAt: 'asc' },
  });
  if (!sales) {
    throw new Error('No SALES_USER found — run `node prisma/seed.js` first.');
  }

  let created = 0;
  let skipped = 0;
  for (const s of SAMPLES) {
    const exists = await prisma.lead.findFirst({
      where: { organizationName: s.organizationName },
      select: { id: true, leadNumber: true },
    });
    if (exists) {
      console.log(`  skip   ${s.category.padEnd(16)} ${s.organizationName} (already ${exists.leadNumber})`);
      skipped += 1;
      continue;
    }

    const { category, requirementDetails, pricing, ...contact } = s;
    const lead = await prisma.$transaction(async (tx) => {
      const leadNumber = await generateLeadNumber(tx);
      return tx.lead.create({
        data: {
          leadNumber,
          category,
          requirementDetails,
          pricing,
          ...contact,
          status: 'NEW',
          createdById: sales.id,
          assignedSalesId: sales.id,
        },
        select: { leadNumber: true },
      });
    });
    console.log(`  create ${category.padEnd(16)} ${s.organizationName} → ${lead.leadNumber}`);
    created += 1;
  }

  console.log(`\nDone. ${created} created, ${skipped} skipped.`);
};

run()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
