# Operator CRM backend — Express 5 + Prisma + Socket.io.
#
# Debian slim (not alpine): LibreOffice is required at runtime for the
# agreement docx→PDF conversion + attachment merge, and its Debian packages
# (with real fonts) are far more reliable than the musl builds.
FROM node:22-bookworm-slim

# LibreOffice Writer (headless docx→pdf) + fonts so generated PDFs don't
# render with missing glyphs. openssl for Prisma's engine.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    libreoffice-writer \
    fonts-dejavu \
    fonts-liberation \
    openssl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for layer caching. `postinstall` runs `prisma generate`,
# which needs the schema present before npm ci.
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev

COPY src ./src
COPY scripts ./scripts
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x docker-entrypoint.sh \
  # Local-disk document fallback (used when R2 env vars aren't set) — owned by
  # the unprivileged node user so uploads work without root.
  && mkdir -p /app/uploads \
  && chown -R node:node /app

USER node

ENV NODE_ENV=production
EXPOSE 5003

# /api/health is unauthenticated.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||5003)+'/api/health').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
