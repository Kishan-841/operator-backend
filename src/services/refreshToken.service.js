import { randomBytes, createHash } from 'node:crypto';
import prisma from '../config/db.js';

// Refresh-token sessions (see docs/superpowers/specs/2026-07-29-refresh-token-sessions-design.md).
// The raw token lives only on the client; we store its sha-256 hash.

// Parse a duration like "7d" / "12h" / "30m" into milliseconds. Defaults to 7d.
const parseDuration = (str, fallbackMs) => {
  const m = /^(\d+)([dhm])$/.exec(String(str || '').trim());
  if (!m) return fallbackMs;
  const n = Number(m[1]);
  const unit = { d: 86400000, h: 3600000, m: 60000 }[m[2]];
  return n * unit;
};

const REFRESH_TTL_MS = parseDuration(process.env.REFRESH_EXPIRES_IN, 7 * 86400000); // 7 days

const hashToken = (raw) => createHash('sha256').update(raw).digest('hex');

/** Mint a new refresh token for a user, store its hash, and return the raw token. */
export const issueRefreshToken = async (userId) => {
  const raw = randomBytes(48).toString('base64url');
  await prisma.refreshToken.create({
    data: { userId, tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + REFRESH_TTL_MS) },
  });
  return raw;
};

/**
 * Look up a live refresh token by its raw value. Returns the row (with userId)
 * when it exists, isn't revoked, and hasn't expired; otherwise null.
 */
export const findLiveRefreshToken = async (raw) => {
  if (!raw || typeof raw !== 'string') return null;
  const row = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashToken(raw) },
    select: { id: true, userId: true, revokedAt: true, expiresAt: true },
  });
  if (!row || row.revokedAt || row.expiresAt <= new Date()) return null;
  return row;
};

/** Revoke a refresh token by raw value (idempotent; unknown tokens are ignored). */
export const revokeRefreshToken = async (raw) => {
  if (!raw || typeof raw !== 'string') return;
  await prisma.refreshToken.updateMany({
    where: { tokenHash: hashToken(raw), revokedAt: null },
    data: { revokedAt: new Date() },
  });
};

/** Revoke a specific token row by id (used during rotation). */
export const revokeRefreshTokenById = async (id) => {
  await prisma.refreshToken.update({ where: { id }, data: { revokedAt: new Date() } });
};
