#!/bin/sh
set -e

# Derive DATABASE_URL from the compose-provided pieces when it isn't set
# explicitly — keeps docker-compose.yml free of ${} interpolation so a plain
# `docker compose up` works without --env-file.
if [ -z "$DATABASE_URL" ]; then
  if [ -z "$POSTGRES_PASSWORD" ]; then
    echo "[entrypoint] ERROR: set POSTGRES_PASSWORD (or a full DATABASE_URL) in .env.docker" >&2
    exit 1
  fi
  export DATABASE_URL="postgresql://operator:${POSTGRES_PASSWORD}@${DB_HOST:-db}:5432/operator_crm?schema=public"
fi

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
