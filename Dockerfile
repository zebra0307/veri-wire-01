FROM node:22-bookworm-slim AS base
WORKDIR /app
RUN corepack enable
RUN apt-get update -y && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*

ARG NEXTAUTH_SECRET=build-only-nextauth-secret-please-change
ARG NEXTAUTH_URL=http://localhost:3000
ARG DATABASE_URL=postgresql://veriwire:veriwire@localhost:5432/veriwire
ARG REDIS_URL=redis://redis:6379

ENV NEXTAUTH_SECRET=$NEXTAUTH_SECRET
ENV NEXTAUTH_URL=$NEXTAUTH_URL
ENV DATABASE_URL=$DATABASE_URL
ENV REDIS_URL=$REDIS_URL

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm prisma generate && pnpm build

EXPOSE 3000
CMD ["sh", "-c", "pnpm prisma migrate deploy || true; pnpm prisma db push; pnpm prisma db seed; pnpm start"]
