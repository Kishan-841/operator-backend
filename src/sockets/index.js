import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import prisma from '../config/db.js';

// Map<userId, Set<socketId>> — a user may be connected from multiple devices.
const userSockets = new Map();
let io = null;

/**
 * Attach Socket.io to the HTTP server with Bearer-token handshake auth.
 *
 * M0 establishes the connection plumbing only — no business events are emitted
 * yet. Stage-transition events (`notification`, `sidebar:refresh`) are wired in
 * Milestone 3 using the helpers below, so this file stays structurally
 * identical to ISP_CRM's sockets/index.js.
 */
export const initializeSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin: process.env.FRONTEND_URL || 'http://localhost:3001',
      credentials: true,
    },
  });

  // Authenticate the handshake. Token is sent via socket.handshake.auth.token.
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('No token provided'));

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        select: { id: true, role: true, isActive: true },
      });
      if (!user || !user.isActive) return next(new Error('Unauthorized'));

      socket.userId = user.id;
      socket.userRole = user.role;
      return next();
    } catch {
      return next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const { userId } = socket;
    if (!userSockets.has(userId)) userSockets.set(userId, new Set());
    userSockets.get(userId).add(socket.id);

    socket.on('disconnect', () => {
      const set = userSockets.get(userId);
      if (set) {
        set.delete(socket.id);
        if (set.size === 0) userSockets.delete(userId);
      }
    });
  });

  return io;
};

/** Emit an event to all of a single user's connected devices. */
export const notifyUser = (userId, event, payload) => {
  const set = userSockets.get(userId);
  if (!io || !set) return;
  for (const socketId of set) io.to(socketId).emit(event, payload);
};

/** Tell a user's clients to refresh their sidebar badge counts. */
export const emitSidebarRefresh = (userId) => notifyUser(userId, 'sidebar:refresh', {});

/** Tell EVERY connected client to refresh sidebar counts (counts are global). */
export const broadcastSidebarRefresh = () => {
  if (io) io.emit('sidebar:refresh', {});
};

export const getIO = () => io;
