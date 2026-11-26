import { getLeadRecord, updateLeadRecordSection } from '../services/leadRecord.service.js';
import { actorFromReq } from '../utils/requestContext.js';
import { handleError } from '../utils/logger.js';

/** GET /api/leads/:id/record (ADMIN) — the whole lead, every stage, documents and notes. */
export const getRecord = async (req, res) => {
  try {
    return res.json({ data: await getLeadRecord(req.params.id) });
  } catch (error) {
    return handleError(res, error, 'leadRecord.get', 'Failed to load the lead record.');
  }
};

/** PATCH /api/leads/:id/record/:section (ADMIN) { data, reason } — edit one stage section. */
export const updateRecordSection = async (req, res) => {
  try {
    const data = await updateLeadRecordSection({
      leadId: req.params.id,
      section: req.params.section,
      data: req.body?.data,
      reason: req.body?.reason,
      actor: actorFromReq(req),
    });
    return res.json({ message: 'Saved.', data });
  } catch (error) {
    if (error?.status === 400 && error.errors) {
      return res.status(400).json({ message: error.message, errors: error.errors });
    }
    return handleError(res, error, 'leadRecord.update', 'Failed to save the change.');
  }
};
