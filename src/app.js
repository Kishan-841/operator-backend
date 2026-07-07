import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

import authRoutes from './routes/auth.routes.js';
import userRoutes from './routes/user.routes.js';
import leadRoutes from './routes/lead.routes.js';
import notificationRoutes from './routes/notification.routes.js';
import reportRoutes from './routes/report.routes.js';
import eventRoutes from './routes/event.routes.js';
import documentTypeRoutes from './routes/documentType.routes.js';
import popRoutes from './routes/pop.routes.js';
import vendorRoutes from './routes/vendor.routes.js';
import noteRoutes from './routes/note.routes.js';
import documentRoutes from './routes/document.routes.js';
import pincodeRoutes from './routes/pincode.routes.js';
import storeRoutes from './routes/store.routes.js';
import { skipRateLimit } from './utils/rateLimit.js';

// The configured Express app, with no server/socket/listen concerns — so it can
// be imported by tests and mounted on an ephemeral port. Startup lives in index.js.

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3001';

const app = express();

// Trust the first proxy hop so req.ip reflects the real client (event log +
// rate limiter) when running behind nginx/a load balancer.
app.set('trust proxy', 1);

app.use(helmet());
app.use(cors({ origin: FRONTEND_URL, credentials: true }));
app.use(express.json());

// Global rate limit — mirrors ISP_CRM's 100 requests/min.
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    skip: skipRateLimit,
    message: { message: 'Too many requests, please try again later.' },
  }),
);

app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'operator-crm-backend' }));

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/leads', leadRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/document-types', documentTypeRoutes);
app.use('/api/pop-locations', popRoutes);
app.use('/api/vendors', vendorRoutes);
app.use('/api/notes', noteRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/pincodes', pincodeRoutes);
app.use('/api/store', storeRoutes);

// 404 + JSON error handler (envelopes per CLAUDE.md §9).
app.use((_req, res) => res.status(404).json({ message: 'Not found.' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  // Structured log; this is the hook point for Sentry (Sentry.captureException(err)).
  console.error(`[error] ${req.method} ${req.originalUrl} —`, err?.message || err);
  res.status(500).json({ message: 'Internal server error.' });
});

export default app;
