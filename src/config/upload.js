import multer from 'multer';

// Files are held in memory then handed to storage.service (Cloudflare R2 when
// the R2_* env vars are set, local disk otherwise). Documents are small, so
// memory is fine.
//
// Accepted: PDF plus common image formats. The extension must be listed AND the
// browser-sent MIME type must match it, so neither can smuggle in another file
// (e.g. HTML). SVG is deliberately absent — it can carry scripts. Some browsers
// send phone photos (HEIC/HEIF) with no type, so those also accept octet-stream.
const NO_TYPE = ['', 'application/octet-stream'];
const MIME_BY_EXT = {
  pdf: ['application/pdf'],
  png: ['image/png'],
  jpg: ['image/jpeg', 'image/jpg', 'image/pjpeg'],
  jpeg: ['image/jpeg', 'image/jpg', 'image/pjpeg'],
  webp: ['image/webp'],
  gif: ['image/gif'],
  bmp: ['image/bmp', 'image/x-ms-bmp'],
  tif: ['image/tiff'],
  tiff: ['image/tiff'],
  heic: ['image/heic', 'image/heic-sequence', ...NO_TYPE],
  heif: ['image/heif', 'image/heif-sequence', ...NO_TYPE],
  avif: ['image/avif'],
};

const extOf = (name) => {
  const parts = String(name || '').toLowerCase().split('.');
  return parts.length > 1 ? parts.pop() : '';
};

export const isAllowedUpload = ({ mimetype = '', originalname = '' } = {}) => {
  const allowed = MIME_BY_EXT[extOf(originalname)];
  return Boolean(allowed) && allowed.includes(String(mimetype).toLowerCase());
};

/**
 * Content type to store and serve for an accepted upload — derived from the
 * extension, never the browser-sent MIME type.
 */
export const uploadContentType = ({ originalname = '' } = {}) => MIME_BY_EXT[extOf(originalname)]?.[0] ?? 'application/octet-stream';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    if (isAllowedUpload(file)) cb(null, true);
    else cb(new Error('Only PDF and image files (JPG, PNG, HEIC, WEBP, GIF, …) are allowed.'));
  },
});

// Wrap so multer/file errors return a clean 400 instead of a 500.
export const uploadSingle = (field) => (req, res, next) => {
  upload.single(field)(req, res, (err) => {
    if (err) return res.status(400).json({ message: err.message || 'Upload failed.' });
    return next();
  });
};

// Multiple files under one field (e.g. agreement attachments). A request with
// no files passes through with req.files = [].
export const uploadArray = (field, maxCount = 10) => (req, res, next) => {
  upload.array(field, maxCount)(req, res, (err) => {
    if (err) return res.status(400).json({ message: err.message || 'Upload failed.' });
    return next();
  });
};
