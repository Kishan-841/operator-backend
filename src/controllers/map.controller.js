import prisma from '../config/db.js';

// Coordinate validity — the map only ever plots a lead at its OWN real
// coordinates (no pincode fallback, no invented location). See Map spec §20/§24.
const validLat = (n) => typeof n === 'number' && Number.isFinite(n) && n >= -90 && n <= 90;
const validLng = (n) => typeof n === 'number' && Number.isFinite(n) && n >= -180 && n <= 180;
// The 0,0 sentinel (Gulf of Guinea) is how "no real location" leaks in — treat as unset.
const isZeroZero = (lat, lng) => Math.abs(lat) < 1e-9 && Math.abs(lng) < 1e-9;

// Canonical status → map progress state. Uses the LeadStatus enum, never UI
// labels, so relabelling a stage never changes marker colours (spec §21).
export const mapProgress = (status) => {
  if (status === 'NEW') return 'NEW'; // stage 1 — waiting to be pushed to feasibility
  if (status === 'REJECTED') return 'REJECTED';
  if (status === 'COMPLETED') return 'COMPLETED';
  return 'IN_PROGRESS'; // pushed ahead: feasibility through client handover
};

/** GET /api/map — every map-eligible lead (admin only). */
export const getLeadMap = async (_req, res) => {
  try {
    const leads = await prisma.lead.findMany({
      // Cheap DB-side prune; range/sentinel validation happens below.
      where: { latitude: { not: null }, longitude: { not: null } },
      select: {
        id: true, leadNumber: true, organizationName: true, category: true, status: true,
        latitude: true, longitude: true, area: true, city: true, pincode: true,
        createdAt: true, updatedAt: true,
        assignedSales: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    const items = [];
    for (const l of leads) {
      const { latitude, longitude } = l;
      if (!validLat(latitude) || !validLng(longitude) || isZeroZero(latitude, longitude)) continue;
      items.push({
        id: l.id,
        leadNumber: l.leadNumber,
        organizationName: l.organizationName,
        category: l.category,
        status: l.status,
        progress: mapProgress(l.status),
        latitude,
        longitude,
        area: l.area ?? null,
        city: l.city ?? null,
        pincode: l.pincode ?? null,
        ownerName: l.assignedSales?.name ?? null,
        createdAt: l.createdAt,
        updatedAt: l.updatedAt,
      });
    }
    return res.json({ items });
  } catch (error) {
    console.error('[map.getLeadMap]', error);
    return res.status(500).json({ message: 'Failed to load map leads.' });
  }
};
