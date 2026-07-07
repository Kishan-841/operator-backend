/**
 * Canonical document types that carry pipeline meaning. The agreement-close gate
 * (verifyAgreement) keys off AGREEMENT, so the value must be stable and matched
 * tolerantly — uploads are canonicalised to this exact string and the gate
 * matches case-insensitively, so a casing/whitespace slip can't brick closure.
 */
export const AGREEMENT_DOC_TYPE = 'AGREEMENT';

export const isAgreementType = (t) =>
  String(t || '').trim().toUpperCase() === AGREEMENT_DOC_TYPE;

/** Normalise a free-text upload type: canonicalise the agreement type, else trim. */
export const canonicalDocType = (t) => {
  const trimmed = String(t || '').trim();
  return isAgreementType(trimmed) ? AGREEMENT_DOC_TYPE : trimmed || 'OTHER';
};
