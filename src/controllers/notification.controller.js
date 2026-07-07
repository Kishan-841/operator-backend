import prisma from '../config/db.js';

/**
 * GET /api/notifications — paginated notifications + unread count for the user.
 * Query: page, limit, filter ('all' | 'unread'). Backward compatible with the
 * bell dropdown (no params → first page of 20, newest first).
 */
export const getNotifications = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const unreadOnly = req.query.filter === 'unread';

    const where = { userId: req.user.id, ...(unreadOnly ? { isRead: false } : {}) };

    const [items, total, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.notification.count({ where }),
      prisma.notification.count({ where: { userId: req.user.id, isRead: false } }),
    ]);

    // Best-effort attach leadNumber for items that soft-reference a lead.
    const leadIds = [...new Set(items.map((n) => n.leadId).filter(Boolean))];
    const leads = leadIds.length
      ? await prisma.lead.findMany({
          where: { id: { in: leadIds } },
          select: { id: true, leadNumber: true },
        })
      : [];
    const leadMap = Object.fromEntries(leads.map((l) => [l.id, l.leadNumber]));

    const enriched = items.map((n) => ({ ...n, leadNumber: n.leadId ? leadMap[n.leadId] || null : null }));

    return res.json({
      items: enriched,
      unreadCount,
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (error) {
    console.error('[notification.get]', error);
    return res.status(500).json({ message: 'Failed to fetch notifications.' });
  }
};

/** POST /api/notifications/:id/read — mark a single notification read. */
export const markRead = async (req, res) => {
  try {
    // Scope to the requester so users can't flip others' notifications.
    const result = await prisma.notification.updateMany({
      where: { id: req.params.id, userId: req.user.id },
      data: { isRead: true },
    });
    if (result.count === 0) return res.status(404).json({ message: 'Notification not found.' });
    return res.json({ message: 'Notification marked read.' });
  } catch (error) {
    console.error('[notification.read]', error);
    return res.status(500).json({ message: 'Failed to update notification.' });
  }
};

/** POST /api/notifications/read-all */
export const markAllRead = async (req, res) => {
  try {
    await prisma.notification.updateMany({
      where: { userId: req.user.id, isRead: false },
      data: { isRead: true },
    });
    return res.json({ message: 'All notifications marked read.' });
  } catch (error) {
    console.error('[notification.readAll]', error);
    return res.status(500).json({ message: 'Failed to update notifications.' });
  }
};
