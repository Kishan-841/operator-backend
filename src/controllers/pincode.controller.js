import prisma from '../config/db.js';

/**
 * GET /api/pincodes?q= — searchable lookup over the All-India pincode master
 * that powers the lead Territory picker. Returns up to 50 matches. Numeric
 * queries match the pincode by prefix (index-friendly); text queries match the
 * office name / district / state. Empty query returns nothing (165k rows — we
 * never dump the whole table).
 */
export const listPincodes = async (req, res) => {
  try {
    const term = req.query.q ? String(req.query.q).trim() : '';
    if (!term) return res.json({ items: [] });

    const where = /^\d+$/.test(term)
      ? { pincode: { startsWith: term } }
      : {
          OR: [
            { officeName: { contains: term, mode: 'insensitive' } },
            { district: { contains: term, mode: 'insensitive' } },
            { state: { contains: term, mode: 'insensitive' } },
          ],
        };

    const items = await prisma.pincode.findMany({
      where,
      orderBy: [{ state: 'asc' }, { district: 'asc' }, { officeName: 'asc' }],
      take: 50,
    });
    return res.json({ items });
  } catch (error) {
    console.error('[pincode.list]', error);
    return res.status(500).json({ message: 'Failed to fetch pincodes.' });
  }
};
