# Build stage
FROM oven/bun:1.4.0-alpine AS builder

# Build dependencies for native modules such as bcrypt.
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
COPY packages/reservoir ./packages/reservoir
COPY packages/backend ./packages/backend

RUN bun run --filter '@logtide/shared' build
RUN bun run --filter '@logtide/reservoir' build
RUN bun run --filter '@logtide/backend' build

# Production stage
FROM oven/bun:1.4.0-alpine

RUN apk add --no-cache netcat-openbsd

WORKDIR /app

COPY package.json bun.lock ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/reservoir/package.json ./packages/reservoir/
COPY packages/backend/package.json ./packages/backend/
COPY packages/frontend/package.json ./packages/frontend/

RUN bun install --frozen-lockfile --production

COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/reservoir/dist ./packages/reservoir/dist
COPY --from=builder /app/packages/backend/dist ./packages/backend/dist
COPY --from=builder /app/packages/backend/migrations ./packages/backend/migrations
COPY --from=builder /app/packages/backend/src/scripts ./packages/backend/src/scripts
COPY --from=builder /app/packages/backend/tsconfig.json ./packages/backend/tsconfig.json
COPY --from=builder /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder /app/packages/reservoir/package.json ./packages/reservoir/package.json

COPY packages/backend/entrypoint.sh ./packages/backend/entrypoint.sh
RUN chmod +x ./packages/backend/entrypoint.sh

WORKDIR /app/packages/backend

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD bun -e "require('http').get('http://localhost:8080/health', (r) => r.statusCode === 200 ? process.exit(0) : process.exit(1))"

ENTRYPOINT ["./entrypoint.sh"]
CMD ["server"]
