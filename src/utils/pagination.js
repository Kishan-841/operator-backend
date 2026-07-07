/**
 * Pagination helpers. List endpoints return the standard envelope
 * `{ items, pagination: { page, limit, total, totalPages } }` (CLAUDE.md §9).
 */

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export const parsePagination = (query = {}) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const rawLimit = parseInt(query.limit, 10) || DEFAULT_LIMIT;
  const limit = Math.min(Math.max(1, rawLimit), MAX_LIMIT);
  return { page, limit, skip: (page - 1) * limit };
};

export const paginatedResponse = ({ items, total, page, limit }) => ({
  items,
  pagination: {
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  },
});
