import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';

/**
 * File storage abstraction. The rest of the app only knows about an opaque
 * `storageKey` — callers never touch paths or buckets directly.
 *
 * Two drivers, picked from the environment at startup:
 *   r2    — Cloudflare R2 (S3-compatible) when all four R2_* vars are set.
 *           Objects are keyed `leads/{leadNumber}/{docType}/{uuid}-{filename}`
 *           so the bucket browses like a folder tree per lead, per doc type.
 *           The bucket stays PRIVATE; downloads stream through our API (which
 *           enforces JWT + roles) — no public URLs.
 *   local — backend/uploads on disk (dev/test default; no setup needed).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_ROOT = path.resolve(__dirname, '../../uploads');

const R2 = {
  accountId: process.env.R2_ACCOUNT_ID,
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  bucket: process.env.R2_BUCKET,
};
const useR2 = Boolean(R2.accountId && R2.accessKeyId && R2.secretAccessKey && R2.bucket);

// Lazy singleton so importing this module never opens connections in tests.
let _s3;
const s3 = () => {
  if (!_s3) {
    _s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${R2.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: R2.accessKeyId, secretAccessKey: R2.secretAccessKey },
    });
  }
  return _s3;
};

export const storageDriver = useR2 ? 'r2' : 'local';

const sanitize = (name) => (name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);

// Keys always use forward slashes (object keys on R2; resolved via path.join
// locally). leadNumber (e.g. OPC-0009) reads better than a UUID when browsing
// the bucket, but fall back to leadId so storage never blocks an upload.
const buildKey = ({ leadId, leadNumber, docType, originalName }) =>
  ['leads', sanitize(leadNumber || leadId), sanitize(docType || 'OTHER'), `${randomUUID()}-${sanitize(originalName)}`].join('/');

export const saveBuffer = async ({ buffer, originalName, contentType, leadId, leadNumber, docType }) => {
  const storageKey = buildKey({ leadId, leadNumber, docType, originalName });
  if (useR2) {
    await s3().send(
      new PutObjectCommand({
        Bucket: R2.bucket,
        Key: storageKey,
        Body: buffer,
        ContentType: contentType || 'application/octet-stream',
      }),
    );
  } else {
    const abs = path.join(UPLOAD_ROOT, storageKey);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, buffer);
  }
  return { storageKey, size: buffer.length };
};

/**
 * Stream a stored file to an Express response as a download. Handles both
 * drivers; resolves the not-found case to a 404 instead of throwing.
 */
export const sendDownload = async (res, { storageKey, fileName, mimeType }) => {
  if (!useR2) {
    return res.download(path.join(UPLOAD_ROOT, storageKey), fileName);
  }
  try {
    const obj = await s3().send(new GetObjectCommand({ Bucket: R2.bucket, Key: storageKey }));
    res.setHeader('Content-Type', mimeType || obj.ContentType || 'application/octet-stream');
    if (obj.ContentLength) res.setHeader('Content-Length', obj.ContentLength);
    res.setHeader('Content-Disposition', `attachment; filename="${sanitize(fileName)}"`);
    return obj.Body.pipe(res);
  } catch (err) {
    if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) {
      return res.status(404).json({ message: 'File not found in storage.' });
    }
    throw err;
  }
};

export const removeFile = async (storageKey) => {
  try {
    if (useR2) {
      await s3().send(new DeleteObjectCommand({ Bucket: R2.bucket, Key: storageKey }));
    } else {
      await fs.promises.unlink(path.join(UPLOAD_ROOT, storageKey));
    }
  } catch (err) {
    // ENOENT/NoSuchKey (already gone) is fine; anything else means a real leak
    // we should surface so an operator can clean it up — never throw (callers
    // soft-fail around storage cleanup).
    if (err?.code !== 'ENOENT' && err?.name !== 'NoSuchKey') {
      console.warn('[storage.removeFile] could not remove', storageKey, err?.message);
    }
  }
};
