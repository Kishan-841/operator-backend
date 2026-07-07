/**
 * Build the actor context for the event log from a request: who (from the auth
 * middleware), and from where (IP + user-agent). `extra` overrides — used by the
 * login handler, which has no req.user yet (passes { id, label: email }).
 *
 * Requires `app.set('trust proxy', 1)` for req.ip to reflect the client behind a proxy.
 */
export const actorFromReq = (req, extra = {}) => ({
  id: req.user?.id ?? null,
  role: req.user?.role ?? null,
  email: req.user?.email ?? null,
  label: req.user?.email ?? null,
  ip: req.ip || req.socket?.remoteAddress || null,
  userAgent: req.get?.('user-agent') || null,
  ...extra,
});
