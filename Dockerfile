# syntax=docker/dockerfile:1
#
# Multi-stage build producing a Next.js standalone server.
# Railway builds with this Dockerfile automatically because it exists at the repo root.

FROM node:22-alpine AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# ---- dependencies -----------------------------------------------------------
FROM base AS deps
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json ./
# Playwright is a devDependency used only by the UI smoke test, and its
# postinstall would otherwise pull ~150MB of Chromium into a build that never
# opens a browser.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci

# ---- build ------------------------------------------------------------------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# `npm run build` runs `prisma generate` first (see package.json).
# A dummy URL satisfies schema parsing; no database is contacted at build time.
ENV DATABASE_URL="postgresql://user:pass@localhost:5432/db"
RUN npm run build

# ---- runtime ----------------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Prisma CLI + schema, needed by the Railway pre-deploy command
# (`prisma migrate deploy`). Next's standalone output prunes node_modules to what
# the app imports at runtime, and nothing imports the CLI — so copy it explicitly.
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@prisma ./node_modules/@prisma

USER nextjs
EXPOSE 3000

# server.js is emitted by Next standalone output and honours PORT/HOSTNAME.
CMD ["node", "server.js"]
