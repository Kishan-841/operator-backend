/**
 * Role helpers — single source of truth for role checks (CLAUDE.md §2).
 *
 * SUPER_ADMIN and ADMIN override all role gates. All other roles are exclusive
 * (one per user). Widen access by editing these functions, not by sprinkling
 * role string comparisons across controllers.
 */

const ADMIN_ROLES = ['SUPER_ADMIN', 'ADMIN'];

/** True if the user has full administrative access. */
export const isAdmin = (user) => ADMIN_ROLES.includes(user?.role);

/** True if the user has the given role (admins always pass). */
export const hasRole = (user, role) => isAdmin(user) || user?.role === role;

/** True if the user has any of the given roles (admins always pass). */
export const hasAnyRole = (user, roles) =>
  isAdmin(user) || (Array.isArray(roles) && roles.includes(user?.role));

export default { isAdmin, hasRole, hasAnyRole };
