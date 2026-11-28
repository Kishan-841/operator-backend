import 'dotenv/config';
import { createServer } from 'http';
import app from './app.js';
import { initializeSocket } from './sockets/index.js';
import { ensureLocationCodes } from './services/popCode.service.js';

// Fail fast on missing critical env vars rather than crashing mid-request hours
// later. DATABASE_URL is validated by Prisma on first query.
const REQUIRED_ENV_VARS = ['JWT_SECRET', 'DATABASE_URL'];
const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(', ')}`);
  process.exit(1);
}

const PORT = process.env.PORT || 5003;

// Last-resort process guards so a stray async error logs instead of silently
// killing the server. (Sentry-ready: capture here too.)
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

const server = createServer(app);
initializeSocket(server);

server.listen(PORT, () => {
  console.log(`Operator CRM backend listening on http://localhost:${PORT}`);
});

// Location IDs (POP-… / JN-…): the one-time renumber, then fix any row without
// a valid ID. Soft-fail: this must never stop the server from serving.
ensureLocationCodes()
  .then(({ renumbered, fixed }) => {
    if (renumbered) console.log(`[popCode] renumbered ${renumbered} location(s) into POP-/JN- series`);
    if (fixed) console.log(`[popCode] assigned IDs to ${fixed} location(s)`);
  })
  .catch((e) => console.warn('[popCode] location IDs not ensured (will retry on next start):', e?.message));
