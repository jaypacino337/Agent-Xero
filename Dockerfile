# ── stage 1: build the dashboard (static Next.js export → dashboard/out) ──
FROM node:22-slim AS dashboard
WORKDIR /dash
COPY dashboard/package.json dashboard/package-lock.json ./
RUN npm ci
COPY dashboard ./
RUN npm run build

# ── stage 2: the agent ──
FROM node:22-slim
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src
COPY --from=dashboard /dash/out ./dashboard/out

# tsx is a devDependency; install it standalone for runtime
RUN npm install --no-save tsx

ENV NODE_ENV=production
# Ledger + crash-safe treasury ledgers live here — attach a Railway volume at /data
ENV DATA_DIR=/data

EXPOSE 3000
CMD ["npx", "tsx", "src/index.ts"]
