// Shared rate-limit skip predicate. Lives in its own module (not app.js) so the
// auth router can import it without a circular dependency.
//
// Skipped under test: the suite fires many requests from one loopback IP in well
// under a minute, which would otherwise trip false 429s.
export const skipRateLimit = () => process.env.NODE_ENV === 'test';
