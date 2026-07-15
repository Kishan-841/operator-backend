/**
 * Required documents per operator category (mirrors frontend
 * lib/doc-requirements.js — source: Optr Document Requirement.md).
 *
 * Nothing is compulsory at the docs-upload stage; the requirement is enforced
 * at the AGREEMENT close-out — a lead can't complete until every required
 * document type has been uploaded.
 */
export const REQUIRED_DOCS = {
  OPERATOR: [
    'Aadhaar Card (Authorized Signatory)',
    'PAN Card (Authorized Signatory)',
    'Shop Act',
    'Udyam Aadhar',
  ],
  ISP: [
    'Aadhaar Card (Authorized Signatory)',
    'PAN Card (Authorized Signatory)',
    "Company's PAN Card",
    'Copy of ISP License',
    'Shop Act / Udyam Aadhar',
    'Purchase Order',
    'GST Certificate',
  ],
};

export const requiredDocsFor = (category) =>
  category === 'ISP' ? REQUIRED_DOCS.ISP : REQUIRED_DOCS.OPERATOR;

/** Required types this lead is still missing (case/whitespace tolerant). */
export const missingRequiredDocs = (category, docs) => {
  const have = new Set(docs.map((d) => String(d.type ?? '').trim().toLowerCase()));
  return requiredDocsFor(category).filter((t) => !have.has(t.toLowerCase()));
};
