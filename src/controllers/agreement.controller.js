import prisma from '../config/db.js';
import * as svc from '../services/agreement.service.js';

/** POST /api/leads/:id/agreement/generate (SOFTWARE / SALES) { orgName, orgAddress, orgOwnerName } */
export const generateAgreement = async (req, res) => {
  try {
    const lead = await prisma.lead.findUnique({
      where: { id: req.params.id },
      select: { leadNumber: true },
    });
    if (!lead) return res.status(404).json({ message: 'Lead not found.' });

    const orgName = String(req.body?.orgName || '').trim();
    if (!orgName) return res.status(400).json({ message: 'Organization name is required.' });

    const { buffer, ext, contentType } = await svc.generateAgreement(
      { orgName, orgAddress: req.body?.orgAddress, orgOwnerName: req.body?.orgOwnerName },
      req.files || [],
    );

    // Soft-stamp when the agreement was generated (drives the queue's step
    // checklist) — never block the download over it.
    try {
      await prisma.lead.update({
        where: { id: req.params.id },
        data: { agreementGeneratedAt: new Date() },
      });
    } catch (e) {
      console.warn('[agreement.generate] could not stamp agreementGeneratedAt:', e?.message);
    }

    const filename = `${lead.leadNumber}-agreement.${ext}`;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(buffer);
  } catch (error) {
    if (error?.status === 400) return res.status(400).json({ message: error.message });
    console.error('[agreement.generate]', error?.message || error);
    return res.status(500).json({ message: 'Failed to generate the agreement.' });
  }
};
