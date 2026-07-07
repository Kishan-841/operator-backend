import multer from 'multer';

// Files are held in memory then handed to storage.service (Cloudflare R2 when
// the R2_* env vars are set, local disk otherwise). Documents are small, so
// memory is fine.
const ALLOWED = ['application/pdf', 'image/png', 'image/jpeg', 'image/jpg', 'image/webp'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    if (ALLOWED.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only PDF and image files (png/jpg/webp) are allowed.'));
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
