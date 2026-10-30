import prisma from '../config/db.js';
import { logEvent } from '../services/statusChangeLog.service.js';
import { actorFromReq } from '../utils/requestContext.js';
import { parsePagination, paginatedResponse } from '../utils/pagination.js';

const isValidCoord = (v, max) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= max;

export const POP_TYPES = ['1G', '10G', '40G', '100G', '200G', '400G'];
export const JUNCTION_TYPES = ['2w Compass', '4w FTA', 'JC 48F', 'JC 96F'];

const typeError = {
  popType: `POP type must be one of: ${POP_TYPES.join(', ')}.`,
  junctionType: `Junction type must be one of: ${JUNCTION_TYPES.join(', ')}.`,
  both: 'Choose either a POP type or a junction type, not both.',
  neither: 'Choose a POP type or a junction type.',
};

/** Canonical spelling of `value` from `allowed` (case-insensitive), '' when blank, undefined when invalid. */
const canonicalType = (value, allowed) => {
  const v = String(value ?? '').trim();
  if (!v) return '';
  return allowed.find((a) => a.toLowerCase() === v.toLowerCase());
};

/**
 * Validate a single-POP body (create + edit). Exactly one type is required here;
 * only the bulk import tolerates neither. Returns { error } or { data }.
 */
const parsePopBody = (body) => {
  const name = String(body?.name || '').trim();
  const latitude = Number(body?.latitude);
  const longitude = Number(body?.longitude);
  const popType = canonicalType(body?.popType, POP_TYPES);
  const junctionType = canonicalType(body?.junctionType, JUNCTION_TYPES);

  if (!name) return { error: 'A POP name is required.' };
  if (!isValidCoord(latitude, 90)) return { error: 'Latitude must be a number between -90 and 90.' };
  if (!isValidCoord(longitude, 180)) return { error: 'Longitude must be a number between -180 and 180.' };
  if (popType === undefined) return { error: typeError.popType };
  if (junctionType === undefined) return { error: typeError.junctionType };
  if (popType && junctionType) return { error: typeError.both };
  if (!popType && !junctionType) return { error: typeError.neither };
  return { data: { name, latitude, longitude, popType: popType || null, junctionType: junctionType || null } };
};

/**
 * GET /api/pop-locations?q= — searchable list of saved POPs (name match).
 * Passing `page` switches to a paginated envelope for the management page; the
 * feasibility picker calls it without `page` and gets the top 50 matches.
 */
export const listPopLocations = async (req, res) => {
  try {
    const term = req.query.q ? String(req.query.q).trim() : '';
    const where = term ? { name: { contains: term, mode: 'insensitive' } } : {};

    if (req.query.page !== undefined) {
      const { page, limit, skip } = parsePagination(req.query);
      const [items, total] = await Promise.all([
        prisma.popLocation.findMany({ where, orderBy: { name: 'asc' }, skip, take: limit }),
        prisma.popLocation.count({ where }),
      ]);
      return res.json(paginatedResponse({ items, total, page, limit }));
    }

    const items = await prisma.popLocation.findMany({
      where,
      orderBy: { name: 'asc' },
      take: 50,
    });
    return res.json({ items });
  } catch (error) {
    console.error('[pop.list]', error);
    return res.status(500).json({ message: 'Failed to fetch POP locations.' });
  }
};

/** POST /api/pop-locations { name, latitude, longitude, popType, junctionType } — create a reusable POP. */
export const createPopLocation = async (req, res) => {
  try {
    const { error, data: fields } = parsePopBody(req.body);
    if (error) return res.status(400).json({ message: error });
    const { name, latitude, longitude } = fields;

    const existing = await prisma.popLocation.findUnique({ where: { name } });
    if (existing) return res.json({ message: 'A POP with this name already exists.', data: existing });

    const data = await prisma.popLocation.create({
      data: { ...fields, createdById: req.user.id },
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

/**
 * PUT /api/pop-locations/:id { name, latitude, longitude, popType, junctionType }
 * — edit a POP. Leads keep the snapshot taken at feasibility, so past display is
 * unaffected by a rename.
 */
export const updatePopLocation = async (req, res) => {
  try {
    const { error, data: fields } = parsePopBody(req.body);
    if (error) return res.status(400).json({ message: error });

    const current = await prisma.popLocation.findUnique({ where: { id: req.params.id } });
    if (!current) return res.status(404).json({ message: 'POP location not found.' });

    const clash = await prisma.popLocation.findFirst({
      where: { name: { equals: fields.name, mode: 'insensitive' }, id: { not: current.id } },
      select: { id: true },
    });
    if (clash) return res.status(409).json({ message: 'A POP with this name already exists.' });

    const data = await prisma.popLocation.update({ where: { id: current.id }, data: fields });

    await logEvent({
      action: 'POP_UPDATED',
      entityType: 'PopLocation',
      entityId: data.id,
      summary: `Updated POP "${data.name}" (${data.latitude}, ${data.longitude}; ${data.popType ?? data.junctionType})`,
      actor: actorFromReq(req),
    });
    return res.json({ message: 'POP location updated.', data });
  } catch (error) {
    console.error('[pop.update]', error);
    return res.status(500).json({ message: 'Failed to update POP location.' });
  }
};

/**
 * POST /api/pop-locations/bulk { rows: [{ name, latitude, longitude, popType?, junctionType? }] } — bulk
 * import (Excel upload, parsed client-side). Validates every row, skips names
 * that already exist or repeat within the file, and creates the rest in one
 * write. Returns { created, skipped, errors: [{ row, name, reason }] } so one
 * bad row never fails the batch. `row` is 1-based to match the spreadsheet.
 * Both types may be blank (older sheets lack the columns); a filled one must be
 * valid, and a row can't fill both.
 */
export const bulkCreatePopLocations = async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
    if (!rows || rows.length === 0) {
      return res.status(400).json({ message: 'Provide at least one POP row to import.' });
    }

    const errors = [];
    const valid = []; // { name, latitude, longitude, popType, junctionType }
    const seen = new Set(); // names already accepted in THIS file (lowercased)
    let skipped = 0;

    rows.forEach((raw, i) => {
      const row = i + 1;
      const name = String(raw?.name || '').trim();
      const latitude = Number(raw?.latitude);
      const longitude = Number(raw?.longitude);
      if (!name) {
        errors.push({ row, name: '', reason: 'A POP name is required.' });
        return;
      }
      if (!isValidCoord(latitude, 90)) {
        errors.push({ row, name, reason: 'Latitude must be a number between -90 and 90.' });
        return;
      }
      if (!isValidCoord(longitude, 180)) {
        errors.push({ row, name, reason: 'Longitude must be a number between -180 and 180.' });
        return;
      }
      const popType = canonicalType(raw?.popType, POP_TYPES);
      const junctionType = canonicalType(raw?.junctionType, JUNCTION_TYPES);
      if (popType === undefined) {
        errors.push({ row, name, reason: typeError.popType });
        return;
      }
      if (junctionType === undefined) {
        errors.push({ row, name, reason: typeError.junctionType });
        return;
      }
      if (popType && junctionType) {
        errors.push({ row, name, reason: typeError.both });
        return;
      }
      if (seen.has(name.toLowerCase())) {
        skipped += 1; // duplicated within the same file
        return;
      }
      seen.add(name.toLowerCase());
      valid.push({ name, latitude, longitude, popType: popType || null, junctionType: junctionType || null });
    });

    // Skip names that already exist in the DB (case-insensitive on the trimmed name).
    const existing = await prisma.popLocation.findMany({
      where: { name: { in: valid.map((v) => v.name) } },
      select: { name: true },
    });
    const existingNames = new Set(existing.map((e) => e.name.toLowerCase()));
    const toCreate = valid.filter((v) => {
      if (existingNames.has(v.name.toLowerCase())) {
        skipped += 1;
        return false;
      }
      return true;
    });

    if (toCreate.length) {
      await prisma.popLocation.createMany({
        data: toCreate.map((v) => ({ ...v, createdById: req.user.id })),
        skipDuplicates: true,
      });
    }

    await logEvent({
      action: 'POP_BULK_IMPORTED',
      entityType: 'PopLocation',
      summary: `Imported ${toCreate.length} POP(s); skipped ${skipped}; ${errors.length} error(s)`,
      actor: actorFromReq(req),
    });

    return res.json({ created: toCreate.length, skipped, errors });
  } catch (error) {
    console.error('[pop.bulkCreate]', error);
    return res.status(500).json({ message: 'Failed to import POP locations.' });
  }
};
