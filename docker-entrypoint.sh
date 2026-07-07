#!/bin/sh
set -e

# Sync the schema on boot (the project deliberately uses `prisma db push`, not
# migrations — CLAUDE.md §9). Set SKIP_DB_PUSH=1 to boot without touching the
# schema (e.g. when several replicas share one database).
if [ "$SKIP_DB_PUSH" != "1" ]; then
  echo "[entrypoint] prisma db push…"
  npx prisma db push --skip-generate
fi

# One-time user seeding (one user per role): run with SEED_USERS=1.
if [ "$SEED_USERS" = "1" ]; then
  echo "[entrypoint] seeding users…"
  node prisma/seed.js
fi

echo "[entrypoint] starting API…"
exec node src/index.js
