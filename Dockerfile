# ---- stage 1: bundle the Node server (worker code + adapters) ----
FROM node:20-bookworm-slim AS serverbuild
WORKDIR /build
COPY worker/package.json ./worker/
COPY worker/tsconfig.json ./worker/
COPY worker/src ./worker/src
COPY server/package.json server/build.mjs ./server/
COPY server/src ./server/src
# runtime deps must be resolvable for bundling; esbuild comes from server devDeps
RUN cd worker && npm install --omit=dev --no-audit --no-fund \
 && cd ../server && npm install --no-audit --no-fund \
 && node build.mjs

# ---- stage 2: build the frontend (same-origin API base) ----
FROM node:20-bookworm-slim AS febuild
WORKDIR /build
COPY frontend/package.json ./
RUN npm install --no-audit --no-fund
COPY frontend/ .
RUN printf 'VITE_API_BASE=\nVITE_CF_WEB_ANALY_TOKEN=\nVITE_IS_TELEGRAM=false\n' > .env.prod \
 && npm run build

# ---- stage 3: runtime ----
FROM node:20-bookworm-slim AS runtime
WORKDIR /app/server
COPY server/package.json ./
# better-sqlite3 has no prebuilt binary for this node patch, so it compiles
# from source: build tools are installed and purged again in one layer
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends python3 make g++ \
 && npm install --omit=dev --no-audit --no-fund \
 && npm cache clean --force \
 && apt-get purge -y -qq python3 make g++ \
 && apt-get autoremove -y -qq \
 && rm -rf /var/lib/apt/lists/*
COPY --from=serverbuild /build/server/dist ./dist
COPY --from=febuild /build/dist /app/frontend/dist
COPY db /app/db
COPY server/config.example.json ./config.example.json
# config.json is provided via bind mount (see docker-compose.yml) or TE_* env vars
ENV NODE_ENV=production
ENV CONFIG_FILE=/app/server/config.json
EXPOSE 48321 25
CMD ["node", "dist/server.js"]
