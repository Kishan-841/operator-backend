import 'dotenv/config';
import { createServer } from 'http';
import app from './app.js';
import { initializeSocket } from './sockets/index.js';

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
