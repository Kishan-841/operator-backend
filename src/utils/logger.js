/**
 * Minimal structured logger + centralised error responder (CLAUDE.md §10 —
 * milestone-8 error monitoring). Emits one-line JSON so logs are grep/ingest
 * friendly, and routes errors through a single sink (`REPORTER`) where a real
 * monitor (Sentry, self-hosted) can be wired later without touching call sites.
 */

// Wire a reporter here when a DSN is available, e.g.
//   import * as Sentry from '@sentry/node'; const REPORTER = (e, meta) => Sentry.captureException(e, { extra: meta });
const REPORTER = null;

const emit = (level, tag, message, meta) => {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, tag, message, ...(meta ? { meta } : {}) });
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
};

export const log = {
  info: (tag, message, meta) => emit('info', tag, message, meta),
  warn: (tag, message, meta) => emit('warn', tag, message, meta),
  error: (tag, message, meta) => emit('error', tag, message, meta),
};

/**
 * Centralised error response. Typed errors (those carrying `.status`, e.g. from
 * the state machine or assertLeadAccess) keep their status + message; everything
 * else is logged structurally and returned as a 500. Returns `res` for chaining.
 */
export const handleError = (res, error, tag, fallback = 'Something went wrong.') => {
  if (error?.status) return res.status(error.status).json({ message: error.message });
  log.error(tag, error?.message || 'unhandled error', { stack: error?.stack });
  if (REPORTER) {
    try {
      REPORTER(error, { tag });
    } catch {
      /* never let reporting break the response */
    }
  }
  return res.status(500).json({ message: fallback });
};
