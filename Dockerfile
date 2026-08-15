FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src
COPY site ./site

# tsx is a devDependency; install it standalone for runtime
RUN npm install --no-save tsx

ENV NODE_ENV=production
# Ledger lives here — attach a Railway volume at /data to persist it
ENV DATA_DIR=/data

EXPOSE 3000
CMD ["npx", "tsx", "src/index.ts"]
