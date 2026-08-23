# Build stage
FROM oven/bun:1.4.0-alpine AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy manifests first so dependency installation can be cached.
COPY package.json bun.lock tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/reservoir/package.json ./packages/reservoir/
COPY packages/backend/package.json ./packages/backend/
COPY packages/frontend/package.json ./packages/frontend/

RUN bun install --frozen-lockfile

COPY packages/shared ./packages/shared
COPY packages/frontend ./packages/frontend

RUN bun run --filter '@logtide/shared' build

ARG PUBLIC_API_URL=http://localhost:8080
ENV PUBLIC_API_URL=$PUBLIC_API_URL

RUN bun run --filter '@logtide/frontend' build

# Production stage
FROM oven/bun:1.4.0-alpine

WORKDIR /app

COPY package.json bun.lock ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/reservoir/package.json ./packages/reservoir/
COPY packages/backend/package.json ./packages/backend/
COPY packages/frontend/package.json ./packages/frontend/

RUN bun install --frozen-lockfile --production

COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/frontend/build ./packages/frontend/build
COPY --from=builder /app/packages/frontend/package.json ./packages/frontend/

WORKDIR /app/packages/frontend

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD bun -e "require('http').get('http://localhost:3000/', (r) => r.statusCode === 200 ? process.exit(0) : process.exit(1))"

CMD ["bun", "build/index.js"]
