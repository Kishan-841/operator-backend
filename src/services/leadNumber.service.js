import prisma from '../config/db.js';

/**
 * Generate the next lead number (OPC-0001, OPC-0002, …).
 *
 * Pass a transaction client (`tx`) so number generation and the lead create
 * commit together — a row-level `increment` makes this race-safe even under
 * concurrent creates. Number gaps on a failed create are acceptable.
 */
export const generateNumber = async (tx, key, prefix) => {
  const counter = await tx.counter.upsert({
    where: { key },
    update: { value: { increment: 1 } },
    create: { key, value: 1 },
  });
  return `${prefix}-${String(counter.value).padStart(4, '0')}`;
};

export const generateLeadNumber = (tx = prisma) => generateNumber(tx, 'LEAD', 'OPC');

/** DR-0001, DR-0002, … — one per delivery (material) request. */
export const generateDeliveryRequestNumber = (tx = prisma) =>
  generateNumber(tx, 'DELIVERY_REQUEST', 'DR');

/** PO-0001, PO-0002, … — one per purchase order. */
export const generatePurchaseOrderNumber = (tx = prisma) =>
  generateNumber(tx, 'PURCHASE_ORDER', 'PO');
