# Stage 1: Builder
FROM node:20-alpine AS builder

RUN apk add --no-cache git

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install

COPY tsconfig.json ./
COPY src/ ./src/

RUN npx tsc

# Stage 2: Runner (distroless-ish, no dev deps)
FROM node:20-alpine AS runner

RUN apk add --no-cache postgresql-client

WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/dist/ ./dist/
COPY --from=builder /app/node_modules/ ./node_modules/
COPY --from=builder /app/package.json ./

EXPOSE 3100

ENTRYPOINT ["node", "dist/index.js"]
CMD []
