# VeriWire Deploy Runbook

## 1) Prerequisites

- Docker + Docker Compose plugin
- Open ports: `80`, `443`
- A configured `.env.production` at repo root

Minimum required environment values:

- `NEXTAUTH_SECRET`
- `NEXTAUTH_URL`
- `DATABASE_URL` (Supabase Postgres URI from the Supabase dashboard)
- `APP_URL`
- `INTERNAL_AGENT_SECRET`

Apply the Prisma schema to Supabase **before** or **right after** first container start (from your laptop or CI: `pnpm prisma db push` or `pnpm prisma migrate deploy` using the same `DATABASE_URL`). The Docker image no longer runs `db push` or seed on startup.

Optional integrations:

- `GEMINI_API_KEY`
- `BRAVE_SEARCH_API_KEY`
- `ELEVENLABS_API_KEY`
- `SUPERPLANE_WEBHOOK_URL`, `SUPERPLANE_SECRET`

## 2) First Deploy

```bash
cp .env.production.example .env.production
# edit .env.production

docker compose --env-file .env.production pull

docker compose --env-file .env.production up -d --build
```

## 3) Health + App Checks

```bash
curl -sS http://localhost:3000/api/health
```

Expected: JSON response with `"ok": true`.

Run smoke checks against the running app:

```bash
pnpm smoke
```

If app is not on `localhost:3000`:

```bash
SMOKE_BASE_URL="https://your-domain" pnpm smoke
```

## 4) Demo Mode Seed (Optional)

When demo auth bypass is enabled (`DEMO_BYPASS_AUTH=true`) — **not for production** — seed deterministic demo rooms:

```bash
curl -X POST -sS http://localhost:3000/api/seed
```

Expected room IDs:

- `VWRM0001`
- `VWRM0002`
- `VWRM0003`

## 5) Update Deploy

```bash
git pull

docker compose --env-file .env.production up -d --build
```

## 6) Logs

```bash
docker compose logs -f next-app

docker compose logs -f postgres

docker compose logs -f caddy
```

## 7) Quick Recovery

```bash
docker compose --env-file .env.production down

docker compose --env-file .env.production up -d --build
```
