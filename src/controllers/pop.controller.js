import prisma from '../config/db.js';
import { logEvent } from '../services/statusChangeLog.service.js';
import { actorFromReq } from '../utils/requestContext.js';
import { parsePagination, paginatedResponse } from '../utils/pagination.js';
import {
  generateLocationCode, codesForRows, codeMatchesSeries, seriesFor, parseManualCode, claimManualCode,
} from '../services/popCode.service.js';
import { isAdmin } from '../utils/roleHelper.js';

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
    // Search by name or POP ID ("POP-007", or just "007").
    const where = term
      ? {
          OR: [
            { name: { contains: term, mode: 'insensitive' } },
            { popCode: { contains: term, mode: 'insensitive' } },
          ],
        }
      : {};

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

    const data = await prisma.$transaction(async (tx) =>
      tx.popLocation.create({
        data: { ...fields, popCode: await generateLocationCode(tx, fields), createdById: req.user.id },
      }),
    );

    await logEvent({
      action: 'POP_CREATED',
      entityType: 'PopLocation',
      entityId: data.id,
      summary: `Created POP ${data.popCode} "${name}" (${latitude}, ${longitude})`,
      actor: actorFromReq(req),
    });
    return res.status(201).json({ message: 'POP location created.', data });
  } catch (error) {
    console.error('[pop.create]', error);
    return res.status(500).json({ message: 'Failed to create POP location.' });
  }
};

/**
 * Validate one spreadsheet row (bulk add + bulk update). Types may both be
 * blank (older sheets lack the columns) but a filled one must be valid, and a
 * row can't fill both. Returns { data } or { error }.
 */
const parseImportRow = (raw) => {
  const name = String(raw?.name || '').trim();
  const latitude = Number(raw?.latitude);
  const longitude = Number(raw?.longitude);
  if (!name) return { error: 'A POP name is required.' };
  if (!isValidCoord(latitude, 90)) return { error: 'Latitude must be a number between -90 and 90.' };
  if (!isValidCoord(longitude, 180)) return { error: 'Longitude must be a number between -180 and 180.' };
  const popType = canonicalType(raw?.popType, POP_TYPES);
  const junctionType = canonicalType(raw?.junctionType, JUNCTION_TYPES);
  if (popType === undefined) return { error: typeError.popType };
  if (junctionType === undefined) return { error: typeError.junctionType };
  if (popType && junctionType) return { error: typeError.both };
  return { data: { name, latitude, longitude, popType: popType || null, junctionType: junctionType || null } };
};

const normalizeCode = (v) => String(v ?? '').replace(/\s+/g, '').toUpperCase();

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

    // An admin may set the ID by hand (popCode in the body, when it differs).
    let manualCode = null;
    if (req.body?.popCode !== undefined && req.body.popCode !== null && req.body.popCode !== current.popCode) {
      if (!isAdmin(req.user)) return res.status(403).json({ message: 'Only admins can change a POP ID.' });
      const parsed = parseManualCode(req.body.popCode, fields);
      if (parsed.error) return res.status(400).json({ message: parsed.error });
      if (parsed.code !== current.popCode) {
        const taken = await prisma.popLocation.findFirst({
          where: { popCode: { equals: parsed.code, mode: 'insensitive' }, id: { not: current.id } },
          select: { name: true },
        });
        if (taken) return res.status(409).json({ message: `${parsed.code} is already used by "${taken.name}".` });
        manualCode = parsed.code;
      }
    }

    const data = await prisma.$transaction(async (tx) => {
      let popCode;
      if (manualCode) {
        await claimManualCode(tx, manualCode, fields);
        popCode = manualCode;
      } else if (!codeMatchesSeries(current.popCode, seriesFor(fields))) {
        // Switching POP ↔ junction moves the location to the other ID series.
        popCode = await generateLocationCode(tx, fields);
      }
      return tx.popLocation.update({
        where: { id: current.id },
        data: { ...fields, ...(popCode ? { popCode } : {}) },
      });
    });

    await logEvent({
      action: 'POP_UPDATED',
      entityType: 'PopLocation',
      entityId: data.id,
      summary:
        `Updated ${data.popCode ?? 'POP'} "${data.name}" (${data.latitude}, ${data.longitude}; ${data.popType ?? data.junctionType})` +
        (current.popCode && current.popCode !== data.popCode ? ` — ID ${current.popCode} → ${data.popCode}` : ''),
      actor: actorFromReq(req),
    });
    return res.json({ message: 'POP location updated.', data });
  } catch (error) {
    if (error?.status === 409) return res.status(409).json({ message: error.message });
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
      // "Add new" never takes IDs — a file with them belongs to "Update existing".
      if (normalizeCode(raw?.popCode)) {
        errors.push({ row, name, reason: 'This row has an ID — use "Update existing POPs" to edit it.' });
        return;
      }
      const { data, error } = parseImportRow(raw);
      if (error) {
        errors.push({ row, name, reason: error });
        return;
      }
      if (seen.has(data.name.toLowerCase())) {
        skipped += 1; // duplicated within the same file
        return;
      }
      seen.add(data.name.toLowerCase());
      valid.push(data);
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
      // One counter bump per series (POP / JN); IDs follow the spreadsheet order.
      await prisma.$transaction(async (tx) => {
        const codes = await codesForRows(tx, toCreate);
        await tx.popLocation.createMany({
          data: toCreate.map((v, i) => ({ ...v, popCode: codes[i], createdById: req.user.id })),
          skipDuplicates: true,
        });
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

/**
 * POST /api/pop-locations/bulk-update { rows: [{ popCode, name, latitude,
 * longitude, popType?, junctionType? }] } — edit existing locations from a
 * spreadsheet (the "Update existing POPs" mode). Rows are matched by ID; the
 * ID itself can't be changed here. Each row replaces the location's name,
 * coordinates and type; unchanged rows are counted, not written. Switching POP
 * ↔ junction moves the row to the other ID series (reported in `recoded`).
 * Returns { updated, unchanged, recoded: [{ row, name, from, to }], errors }.
 */
export const bulkUpdatePopLocations = async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
    if (!rows || rows.length === 0) {
      return res.status(400).json({ message: 'Provide at least one row to update.' });
    }

    const errors = [];
    const candidates = []; // { row, code, data }
    const seenCodes = new Set();
    const seenNames = new Map(); // lowercased name → code claiming it in this file
    rows.forEach((raw, i) => {
      const row = i + 1;
      const name = String(raw?.name || '').trim();
      const code = normalizeCode(raw?.popCode);
      if (!code) {
        errors.push({ row, name, reason: 'The ID is missing — new locations go through "Add new POPs".' });
        return;
      }
      if (seenCodes.has(code)) {
        errors.push({ row, name, reason: `${code} appears more than once in this file.` });
        return;
      }
      seenCodes.add(code);
      const { data, error } = parseImportRow(raw);
      if (error) {
        errors.push({ row, name, reason: error });
        return;
      }
      const other = seenNames.get(data.name.toLowerCase());
      if (other) {
        errors.push({ row, name, reason: `The name is also used by ${other} in this file.` });
        return;
      }
      seenNames.set(data.name.toLowerCase(), code);
      candidates.push({ row, code, data });
    });

    const byCode = new Map(
      (await prisma.popLocation.findMany({ where: { popCode: { in: candidates.map((c) => c.code) } } })).map((p) => [p.popCode, p]),
    );
    const nameOwners = await prisma.popLocation.findMany({
      where: { name: { in: candidates.map((c) => c.data.name), mode: 'insensitive' } },
      select: { id: true, name: true, popCode: true },
    });

    let updated = 0;
    let unchanged = 0;
    const recoded = [];
    const same = (a, b) => a === b || (a == null && b == null);
    for (const { row, code, data } of candidates) {
      const current = byCode.get(code);
      if (!current) {
        errors.push({ row, name: data.name, reason: `No location has the ID ${code}.` });
        continue;
      }
      const clash = nameOwners.find((o) => o.id !== current.id && o.name.toLowerCase() === data.name.toLowerCase());
      if (clash) {
        errors.push({ row, name: data.name, reason: `The name is already used by ${clash.popCode || 'another location'}.` });
        continue;
      }
      const fields = ['name', 'latitude', 'longitude', 'popType', 'junctionType'];
      const changes = fields
        .filter((f) => !same(current[f], data[f]))
        .map((f) => ({ field: f, from: current[f] ?? null, to: data[f] ?? null }));
      if (!changes.length) {
        unchanged += 1;
        continue;
      }
      const saved = await prisma.$transaction(async (tx) => {
        const popCode = codeMatchesSeries(current.popCode, seriesFor(data)) ? undefined : await generateLocationCode(tx, data);
        return tx.popLocation.update({ where: { id: current.id }, data: { ...data, ...(popCode ? { popCode } : {}) } });
      });
      if (saved.popCode !== current.popCode) {
        recoded.push({ row, name: saved.name, from: current.popCode, to: saved.popCode });
        changes.push({ field: 'popCode', from: current.popCode, to: saved.popCode });
      }
      await logEvent({
        action: 'POP_UPDATED',
        entityType: 'PopLocation',
        entityId: saved.id,
        summary: `Bulk-updated ${saved.popCode} "${saved.name}" (${changes.map((c) => c.field).join(', ')})`,
        changes,
        actor: actorFromReq(req),
      });
      updated += 1;
    }

    await logEvent({
      action: 'POP_BULK_UPDATED',
      entityType: 'PopLocation',
      summary: `Bulk update: ${updated} updated, ${unchanged} unchanged, ${errors.length} error(s)`,
      actor: actorFromReq(req),
    });
    errors.sort((a, b) => a.row - b.row);
    return res.json({ updated, unchanged, recoded, errors });
  } catch (error) {
    console.error('[pop.bulkUpdate]', error);
    return res.status(500).json({ message: 'Failed to update POP locations.' });
  }
};
