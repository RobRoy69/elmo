# Elmo 
# Supports: web app (Nitro server) and worker

# Base stage with Node.js
FROM node:24.20.0-bookworm-slim@sha256:6642ef280aebc09c4541bee0b15c9f89f0f3f3c247ddee79ae1d37eddfdcbbaa AS base
RUN corepack enable pnpm

# Dependencies stage
FROM base AS deps
WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/
COPY apps/worker/package.json ./apps/worker/
COPY packages/ui/package.json ./packages/ui/
COPY packages/config/package.json ./packages/config/
COPY packages/lib/package.json ./packages/lib/
COPY packages/local/package.json ./packages/local/
COPY packages/whitelabel/package.json ./packages/whitelabel/
COPY packages/cloud/package.json ./packages/cloud/
COPY packages/deployment/package.json ./packages/deployment/
COPY packages/og/package.json ./packages/og/
COPY packages/api-spec/package.json ./packages/api-spec/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Builder stage
FROM base AS builder
WORKDIR /app

# Copy dependencies
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=deps /app/packages/ui/node_modules ./packages/ui/node_modules
COPY --from=deps /app/packages/config/node_modules ./packages/config/node_modules
COPY --from=deps /app/packages/lib/node_modules ./packages/lib/node_modules
COPY --from=deps /app/packages/local/node_modules ./packages/local/node_modules
COPY --from=deps /app/packages/whitelabel/node_modules ./packages/whitelabel/node_modules
COPY --from=deps /app/packages/cloud/node_modules ./packages/cloud/node_modules
COPY --from=deps /app/packages/deployment/node_modules ./packages/deployment/node_modules
COPY --from=deps /app/packages/og/node_modules ./packages/og/node_modules

# Copy source code
COPY . .

# Build arguments for VITE_ env vars (baked into client bundle)
ARG DEPLOYMENT_MODE=local
ARG VITE_DEPLOYMENT_MODE=${DEPLOYMENT_MODE}
ENV VITE_DEPLOYMENT_MODE=${VITE_DEPLOYMENT_MODE}

# Build the web application (increase heap for large bundles)
RUN pnpm --filter @workspace/web build
RUN pnpm --filter @workspace/worker build:runtime

# Create pruned standalone deployments (only each package's own deps)
# --legacy: deploy without changing the workspace's existing package-link layout.
RUN pnpm --filter @workspace/worker deploy --prod --legacy /deploy/worker
RUN pnpm --filter @workspace/lib deploy --prod --legacy /deploy/lib
RUN cp /app/apps/worker/dist-runtime/index.mjs /deploy/worker/index.mjs

# Runner stage for web app (Nitro)
FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:23a384b4596ec311f78ac9c46af2b8cc0ed403d1f9c3c249111266d7f56319db AS web
WORKDIR /app

ENV NODE_ENV=production

# Copy Nitro output - this is the entire server bundle
COPY --from=builder --chown=65532:65532 /app/apps/web/.output ./.output

USER 65532:65532

EXPOSE 3000
ENV PORT=3000
ENV HOST="0.0.0.0"

CMD [".output/server/index.mjs"]

# Migration stage — applies checked-in migrations then exits
FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:23a384b4596ec311f78ac9c46af2b8cc0ed403d1f9c3c249111266d7f56319db AS migrate
WORKDIR /app

COPY --from=builder --chown=65532:65532 /deploy/lib ./

USER 65532:65532

CMD ["--experimental-strip-types", "scripts/migrate.mts"]

# Worker stage
FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:23a384b4596ec311f78ac9c46af2b8cc0ed403d1f9c3c249111266d7f56319db AS worker
WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder --chown=65532:65532 /deploy/worker ./

USER 65532:65532

CMD ["index.mjs"]
