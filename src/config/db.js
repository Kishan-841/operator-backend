import { PrismaClient } from '@prisma/client';

// Single Prisma client for the whole process. In dev, nodemon restarts the
// process on every change so we don't need the globalThis caching trick that
// Next.js hot-reload requires — a plain singleton module export is enough.
const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'production' ? ['error'] : ['warn', 'error'],
});

export default prisma;
