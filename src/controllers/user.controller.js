import bcrypt from 'bcryptjs';
import prismaPkg from '@prisma/client';
import prisma from '../config/db.js';
import { parsePagination, paginatedResponse } from '../utils/pagination.js';
import { logEvent, diffFields } from '../services/statusChangeLog.service.js';
import { actorFromReq } from '../utils/requestContext.js';

const { Role } = prismaPkg;
const VALID_ROLES = Object.values(Role);
const ADMIN_ROLES = [Role.SUPER_ADMIN, Role.ADMIN];

// Never expose the password hash.
const publicSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
};

/** GET /api/users — search (name/email) + role filter + pagination. */
export const getUsers = async (req, res) => {
  try {
    const { search, role } = req.query;
    const term = search ? String(search).trim() : '';

    const where = {
      ...(role && VALID_ROLES.includes(role) ? { role } : {}),
      ...(term
        ? {
            OR: [
              { name: { contains: term, mode: 'insensitive' } },
              { email: { contains: term, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const { page, limit, skip } = parsePagination(req.query);
    const [items, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: publicSelect,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.user.count({ where }),
    ]);

    return res.json(paginatedResponse({ items, total, page, limit }));
  } catch (error) {
    console.error('[user.getUsers]', error);
    return res.status(500).json({ message: 'Failed to fetch users.' });
  }
};

/** GET /api/users/by-role?role= — lightweight active-user list for assignment dropdowns. */
export const getUsersByRole = async (req, res) => {
  try {
    const { role } = req.query;
    const where = {
      isActive: true,
      ...(role && VALID_ROLES.includes(role) ? { role } : {}),
    };
    const items = await prisma.user.findMany({
      where,
      select: { id: true, name: true, role: true },
      orderBy: { name: 'asc' },
    });
    return res.json({ items });
  } catch (error) {
    console.error('[user.getUsersByRole]', error);
    return res.status(500).json({ message: 'Failed to fetch users.' });
  }
};

/** GET /api/users/:id */
export const getUserById = async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: publicSelect,
    });
    if (!user) return res.status(404).json({ message: 'User not found.' });
    return res.json({ user });
  } catch (error) {
    console.error('[user.getUserById]', error);
    return res.status(500).json({ message: 'Failed to fetch user.' });
  }
};

/** POST /api/users */
export const createUser = async (req, res) => {
  try {
    const { name, email, password, role } = req.body || {};

    if (!name || !email || !password || !role) {
      return res.status(400).json({ message: 'Name, email, password, and role are required.' });
    }
    if (typeof email !== 'string' || typeof password !== 'string' || typeof name !== 'string') {
      return res.status(400).json({ message: 'Name, email, and password must be text.' });
    }
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ message: 'Invalid role.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters.' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const existing = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true },
    });
    if (existing) {
      return res.status(400).json({ message: 'A user with this email already exists.' });
    }

    const user = await prisma.user.create({
      data: {
        name: name.trim(),
        email: normalizedEmail,
        password: await bcrypt.hash(password, 10),
        role,
      },
      select: publicSelect,
    });

    await logEvent({
      action: 'USER_CREATED',
      entityType: 'User',
      entityId: user.id,
      summary: `Created user ${user.email} (${user.role})`,
      actor: actorFromReq(req),
    });
    return res.status(201).json({ message: 'User created.', data: user });
  } catch (error) {
    console.error('[user.createUser]', error);
    return res.status(500).json({ message: 'Failed to create user.' });
  }
};

/** PUT /api/users/:id — update name/email/role; re-hash if password supplied. */
export const updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, role, password } = req.body || {};

    const target = await prisma.user.findUnique({
      where: { id },
      select: { id: true, name: true, email: true, role: true },
    });
    if (!target) return res.status(404).json({ message: 'User not found.' });

    // Self-lockout guard: can't strip your own admin role.
    if (id === req.user.id && role && !ADMIN_ROLES.includes(role)) {
      return res.status(400).json({ message: 'You cannot remove your own admin role.' });
    }
    if (role && !VALID_ROLES.includes(role)) {
      return res.status(400).json({ message: 'Invalid role.' });
    }

    if ((name != null && typeof name !== 'string') ||
        (email != null && typeof email !== 'string') ||
        (password != null && typeof password !== 'string')) {
      return res.status(400).json({ message: 'Name, email, and password must be text.' });
    }
    const data = {};
    if (name) data.name = name.trim();
    if (role) data.role = role;
    if (email) {
      const normalizedEmail = email.toLowerCase().trim();
      const clash = await prisma.user.findFirst({
        where: { email: normalizedEmail, NOT: { id } },
        select: { id: true },
      });
      if (clash) return res.status(400).json({ message: 'A user with this email already exists.' });
      data.email = normalizedEmail;
    }
    if (password) {
      if (password.length < 6) {
        return res.status(400).json({ message: 'Password must be at least 6 characters.' });
      }
      data.password = await bcrypt.hash(password, 10);
    }

    const user = await prisma.user.update({ where: { id }, data, select: publicSelect });

    const changes = diffFields(target, user, ['name', 'email', 'role']);
    if (data.password) changes.push({ field: 'password', from: null, to: '(changed)' });
    if (changes.length) {
      await logEvent({
        action: 'USER_UPDATED',
        entityType: 'User',
        entityId: id,
        summary: `Updated user ${user.email} (${changes.map((c) => c.field).join(', ')})`,
        changes,
        actor: actorFromReq(req),
      });
    }
    return res.json({ message: 'User updated.', data: user });
  } catch (error) {
    console.error('[user.updateUser]', error);
    return res.status(500).json({ message: 'Failed to update user.' });
  }
};

/** PATCH /api/users/:id/active — soft enable/disable. */
export const setUserActive = async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body || {};

    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ message: 'isActive (boolean) is required.' });
    }
    if (id === req.user.id && isActive === false) {
      return res.status(400).json({ message: 'You cannot deactivate your own account.' });
    }

    const target = await prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!target) return res.status(404).json({ message: 'User not found.' });

    const user = await prisma.user.update({ where: { id }, data: { isActive }, select: publicSelect });

    await logEvent({
      action: isActive ? 'USER_ACTIVATED' : 'USER_DEACTIVATED',
      entityType: 'User',
      entityId: id,
      summary: `${isActive ? 'Activated' : 'Deactivated'} user ${user.email}`,
      actor: actorFromReq(req),
    });
    return res.json({ message: isActive ? 'User activated.' : 'User deactivated.', data: user });
  } catch (error) {
    console.error('[user.setUserActive]', error);
    return res.status(500).json({ message: 'Failed to update user.' });
  }
};

/** POST /api/users/:id/reset-password */
export const resetUserPassword = async (req, res) => {
  try {
    const { id } = req.params;
    const { newPassword } = req.body || {};

    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ message: 'New password must be at least 6 characters.' });
    }

    const target = await prisma.user.findUnique({ where: { id }, select: { id: true, email: true } });
    if (!target) return res.status(404).json({ message: 'User not found.' });

    await prisma.user.update({
      where: { id },
      data: { password: await bcrypt.hash(newPassword, 10) },
    });

    await logEvent({
      action: 'PASSWORD_RESET',
      entityType: 'User',
      entityId: id,
      summary: `Reset password for ${target.email}`,
      actor: actorFromReq(req),
    });
    return res.json({ message: 'Password reset.' });
  } catch (error) {
    console.error('[user.resetUserPassword]', error);
    return res.status(500).json({ message: 'Failed to reset password.' });
  }
};
