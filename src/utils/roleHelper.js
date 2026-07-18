/**
 * Role helpers — single source of truth for role checks (CLAUDE.md §2).
 *
 * SUPER_ADMIN and ADMIN override all role gates. A staff user is authorized by
 * the SET of accesses granted to them (multi-access-users), not a single role.
 * Widen access by editing these functions, not by sprinkling role string
 * comparisons across controllers.
 */

const ADMIN_ROLES = ['SUPER_ADMIN', 'ADMIN'];

/** True if the user has full administrative access. */
export const isAdmin = (user) => ADMIN_ROLES.includes(user?.role);

/** True if the user holds the given access (admins always pass). */
export const hasAccess = (user, role) => isAdmin(user) || (user?.accesses ?? []).includes(role);

/** True if the user has the given role (admins always pass). Alias of hasAccess. */
export const hasRole = (user, role) => hasAccess(user, role);

/** True if the user holds any of the given accesses (admins always pass). */
export const hasAnyRole = (user, roles) =>
  isAdmin(user) || (Array.isArray(roles) && roles.some((r) => hasAccess(user, r)));

export default { isAdmin, hasAccess, hasRole, hasAnyRole };
