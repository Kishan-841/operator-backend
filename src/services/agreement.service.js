import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';
import { PDFDocument } from 'pdf-lib';

const here = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(here, '..', 'templates', 'agreement.docx');
const ISP_SLA_TEMPLATE_PATH = path.join(here, '..', 'templates', 'isp_sla.docx');

// "executed on this the {Agreement Date} at Pune" — legal ordinal style.
const ordinal = (n) => {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
  return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'}`;
};
export const formatAgreementDate = (date) => {
  const month = date.toLocaleString('en-GB', { month: 'long' });
  return `${ordinal(date.getDate())} day of ${month}, ${date.getFullYear()}`;
};

// The placeholders inside the .docx template ({Org Name} etc.) → form fields.
const fill = ({ orgName, orgAddress, orgOwnerName, agreementDate }) => {
  const zip = new PizZip(fs.readFileSync(TEMPLATE_PATH));
  const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
  doc.render({
    'Org Name': orgName || '',
    'Org Address': orgAddress || '',
    'Org Owner Name': orgOwnerName || '',
    'Agreement Date': formatAgreementDate(agreementDate || new Date()),
  });
  return doc.getZip().generate({ type: 'nodebuffer' });
};

// The ISP SLA (Service Level Agreement) — four fill-ins at the top of the doc.
const fillIspSla = ({ customerName, officeAddress, effectiveDate, cafNumber }) => {
  const zip = new PizZip(fs.readFileSync(ISP_SLA_TEMPLATE_PATH));
  const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
  doc.render({
    'Effective Date': effectiveDate ? effectiveDate.toLocaleDateString('en-GB') : '',
    'Customer Name': customerName || '',
    'CAF No': cafNumber || '',
    'Office Address': officeAddress || '',
  });
  return doc.getZip().generate({ type: 'nodebuffer' });
};

// Optional office→pdf via LibreOffice if it's installed. Returns a Buffer or null.
const SOFFICE_CANDIDATES = [
  process.env.SOFFICE_PATH,
  'soffice',
  'libreoffice',
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
].filter(Boolean);

const officeToPdf = async (buffer, ext = 'docx') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agreement-'));
  const inPath = path.join(dir, `in.${ext}`);
  const pdfPath = path.join(dir, 'in.pdf');
  fs.writeFileSync(inPath, buffer);
  try {
    for (const bin of SOFFICE_CANDIDATES) {
      try {
        await new Promise((resolve, reject) => {
          execFile(
            bin,
            ['--headless', '--convert-to', 'pdf', '--outdir', dir, inPath],
            { timeout: 60000 },
            (err) => (err ? reject(err) : resolve()),
          );
        });
        if (fs.existsSync(pdfPath)) return fs.readFileSync(pdfPath);
      } catch {
        // try the next candidate binary
      }
    }
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

// Turn one attachment into PDF bytes: PDFs pass through, images get embedded as a
// page (no LibreOffice needed), other office files go through LibreOffice.
const attachmentToPdf = async ({ buffer, mimetype, originalname }) => {
  const ext = (originalname?.split('.').pop() || '').toLowerCase();
  if (mimetype === 'application/pdf' || ext === 'pdf') return buffer;

  const isPng = mimetype === 'image/png' || ext === 'png';
  const isJpg = mimetype === 'image/jpeg' || ['jpg', 'jpeg'].includes(ext);
  if (isPng || isJpg) {
    const pdf = await PDFDocument.create();
    const img = isPng ? await pdf.embedPng(buffer) : await pdf.embedJpg(buffer);
    const page = pdf.addPage([img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    return Buffer.from(await pdf.save());
  }
  // webp / docx / anything else LibreOffice can open
  return officeToPdf(buffer, ext || 'bin');
};

const mergePdfs = async (pdfBuffers) => {
  const merged = await PDFDocument.create();
  for (const bytes of pdfBuffers) {
    if (!bytes) continue;
    try {
      const src = await PDFDocument.load(bytes);
      const pages = await merged.copyPages(src, src.getPageIndices());
      pages.forEach((p) => merged.addPage(p));
    } catch {
      // skip an unreadable attachment rather than failing the whole document
    }
  }
  return Buffer.from(await merged.save());
};

const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * Fill the agreement template, optionally merging attachments after it.
 * - No attachments: returns a PDF if LibreOffice is available, else the .docx.
 * - With attachments: returns one combined PDF (agreement first, then each
 *   attachment); requires LibreOffice to render the agreement as PDF.
 */
export const generateAgreement = async (data, attachments = [], template = 'FRANCHISE') => {
  const docx = template === 'ISP_SLA' ? fillIspSla(data) : fill(data);
  const agreementPdf = await officeToPdf(docx, 'docx');

  if (!agreementPdf) {
    if (attachments.length) {
      const err = new Error('LibreOffice is required to merge attachments into a combined PDF.');
      err.status = 400;
      throw err;
    }
    return { buffer: docx, ext: 'docx', contentType: DOCX_TYPE };
  }

  if (!attachments.length) {
    return { buffer: agreementPdf, ext: 'pdf', contentType: 'application/pdf' };
  }

  const attachmentPdfs = [];
  for (const att of attachments) {
    const pdf = await attachmentToPdf(att);
    if (pdf) attachmentPdfs.push(pdf);
  }
  const combined = await mergePdfs([agreementPdf, ...attachmentPdfs]);
  return { buffer: combined, ext: 'pdf', contentType: 'application/pdf' };
};
