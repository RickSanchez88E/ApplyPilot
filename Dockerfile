# ── Stage 1: Build frontend ───────────────────────────────────
FROM node:22-alpine AS frontend-builder

WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --ignore-scripts
COPY frontend/ ./
RUN npm run build
# vite outputs to ../public (/app/public)

# ── Stage 2: Build backend ───────────────────────────────────
FROM node:22-alpine AS backend-builder

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@latest --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.base.json tsconfig.json ./
COPY src/ ./src/
RUN pnpm run build

# ── Stage 3: Production ─────────────────────────────────────
FROM node:22-bookworm-slim AS runner

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@latest --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# Google Chrome (cdp-pool uses channel:"chrome", not bundled Chromium)
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright install --with-deps chrome && \
    rm -rf /tmp/* /var/cache/apt/archives/*

COPY --from=backend-builder /app/dist ./dist
COPY --from=frontend-builder /app/public ./public
COPY src/db/migrations/ ./src/db/migrations/

RUN groupadd --gid 1001 appgroup && \
    useradd --uid 1001 --gid appgroup --create-home appuser && \
    chown -R appuser:appgroup /app /ms-playwright
USER appuser

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://localhost:3000/api/status').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
