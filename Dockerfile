# syntax=docker/dockerfile:1

# =============================================================================
# Stage 1 — builder: install all deps, compile TS -> dist, then drop dev deps.
# =============================================================================
FROM node:22-slim AS builder
WORKDIR /app

# Install deps against the lockfile first (better layer caching).
COPY package.json package-lock.json ./
RUN npm ci

# Compile.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Strip dev dependencies so we copy a lean node_modules into the runtime image.
RUN npm prune --omit=dev

# =============================================================================
# Stage 2 — runtime: minimal image that runs the compiled server.
# =============================================================================
FROM node:22-slim AS runtime
# PORT matches the app's own default (src/config/env.ts) and EXPOSE / HEALTHCHECK below.
ENV NODE_ENV=production
ENV PORT=4000
WORKDIR /app

# RDS global CA bundle, baked in so verified TLS works out of the box.
# Set PGSSL=true and PGSSL_CA=./certs/global-bundle.pem at runtime to use it.
ADD https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
    ./certs/global-bundle.pem

# App artifacts only — source and dev deps stay out of the final image.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY migrations ./migrations
COPY package.json ./

# Run as the unprivileged built-in `node` user.
RUN chown -R node:node /app
USER node

EXPOSE 4000

# Liveness via the app's own /health route (Node 22 has global fetch — no curl needed).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The server connects to the DB on boot and fails fast if it can't.
CMD ["node", "dist/server.js"]
