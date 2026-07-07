import prisma from '../config/db.js';
import {
  notifyUser as socketEmitToUser,
  emitSidebarRefresh,
  broadcastSidebarRefresh,
} from '../sockets/index.js';

/**
 * Notifications + real-time fan-out. All soft-fail (CLAUDE.md §9): a notification
 * or socket error must never roll back the transition that triggered it.
 */

/** Persist a notification for one user and push it (+ a sidebar refresh) live. */
export const createNotification = async ({ userId, type, title, message, leadId }) => {
  try {
    const n = await prisma.notification.create({
      data: { userId, type, title, message: message ?? null, leadId: leadId ?? null },
    });
    socketEmitToUser(userId, 'notification', {
      id: n.id,
      type: n.type,
      title: n.title,
      message: n.message,
      leadId: n.leadId,
      createdAt: n.createdAt,
    });
    emitSidebarRefresh(userId);
    return n;
  } catch (error) {
    console.warn('[notification.create] non-fatal:', error?.message);
    return null;
  }
};

/** Notify every active user holding any of the given roles (an incoming queue). */
export const notifyRoles = async (roles, payload) => {
  try {
    const users = await prisma.user.findMany({
      where: { role: { in: roles }, isActive: true },
      select: { id: true },
    });
    await Promise.all(users.map((u) => createNotification({ ...payload, userId: u.id })));
  } catch (error) {
    console.warn('[notification.notifyRoles] non-fatal:', error?.message);
  }
};

/** Notify a single user (e.g. the lead's sales owner). */
export const notifyOneUser = (userId, payload) => createNotification({ ...payload, userId });

/**
 * Refresh sidebar badge counts after a transition.
 *
 * Sidebar counts are GLOBAL (per pipeline status), so one transition can change
 * a queue that several roles see at once — and the changed queue is visible to
 * EVERY user of an owning role, not just the transition's notification target.
 * Scoping the refresh to a subset (the old behaviour) left other users with
 * stale badges (e.g. non-owner sales after an approval; delivery after a
 * dispatch). We therefore broadcast to all connected clients; the event is just
 * a cheap "re-fetch your counts" ping. `_roles` is accepted for call-site
 * context but no longer scopes the emit.
 */
export const refreshSidebarForRoles = async (_roles) => {
  try {
    broadcastSidebarRefresh();
  } catch (error) {
    console.warn('[notification.refreshSidebar] non-fatal:', error?.message);
  }
};
