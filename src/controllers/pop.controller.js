import prisma from '../config/db.js';
import { logEvent } from '../services/statusChangeLog.service.js';
import { actorFromReq } from '../utils/requestContext.js';

const isValidCoord = (v, max) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= max;

/** GET /api/pop-locations?q= — searchable list of saved POPs (name match). */
export const listPopLocations = async (req, res) => {
  try {
    const term = req.query.q ? String(req.query.q).trim() : '';
    const items = await prisma.popLocation.findMany({
      where: term ? { name: { contains: term, mode: 'insensitive' } } : {},
      orderBy: { name: 'asc' },
      take: 50,
    });
    return res.json({ items });
  } catch (error) {
    console.error('[pop.list]', error);
    return res.status(500).json({ message: 'Failed to fetch POP locations.' });
  }
};

/** POST /api/pop-locations { name, latitude, longitude } — create a reusable POP. */
export const createPopLocation = async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const latitude = Number(req.body?.latitude);
    const longitude = Number(req.body?.longitude);

    if (!name) return res.status(400).json({ message: 'A POP name is required.' });
    if (!isValidCoord(latitude, 90)) {
      return res.status(400).json({ message: 'Latitude must be a number between -90 and 90.' });
    }
    if (!isValidCoord(longitude, 180)) {
      return res.status(400).json({ message: 'Longitude must be a number between -180 and 180.' });
    }

    const existing = await prisma.popLocation.findUnique({ where: { name } });
    if (existing) return res.json({ message: 'A POP with this name already exists.', data: existing });

    const data = await prisma.popLocation.create({
      data: { name, latitude, longitude, createdById: req.user.id },
    });

    await logEvent({
      action: 'POP_CREATED',
      entityType: 'PopLocation',
      entityId: data.id,
      summary: `Created POP "${name}" (${latitude}, ${longitude})`,
      actor: actorFromReq(req),
    });
    return res.status(201).json({ message: 'POP location created.', data });
  } catch (error) {
    console.error('[pop.create]', error);
    return res.status(500).json({ message: 'Failed to create POP location.' });
  }
};
