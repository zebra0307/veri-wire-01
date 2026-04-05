# VeriWire Deploy Runbook (No Docker)

## 1) Prerequisites

- Node.js 20+ and pnpm
- Access to Postgres (Supabase recommended)
- Optional Redis (if absent, app falls back to in-memory limiter)
- A configured `.env.production`

Required values:
- `NEXTAUTH_SECRET`
- `NEXTAUTH_URL`
- `DATABASE_URL`
- `SPACETIMEDB_ENDPOINT`
- `APP_URL`
- `INTERNAL_AGENT_SECRET`

Optional values:
- `REDIS_URL`
- `GEMINI_API_KEY`
- `ELEVENLABS_API_KEY`
- `SUPERPLANE_WEBHOOK_URL`
- `SUPERPLANE_SECRET`

## 2) First Deploy

```bash
cp .env.production.example .env.production
# edit .env.production

pnpm install --frozen-lockfile
pnpm prisma generate
pnpm prisma migrate deploy
pnpm build
```

## 3) Start App

```bash
pnpm start
```

For long-running service mode, run with your process manager (systemd/PM2/etc).

## 4) Health + Smoke

```bash
curl -sS http://localhost:3000/api/health
pnpm smoke
```

If app is on a different origin:

```bash
SMOKE_BASE_URL="https://your-domain" pnpm smoke
```

## 5) Demo seed (optional)

Only when `DEMO_BYPASS_AUTH=true`:

```bash
curl -X POST -sS http://localhost:3000/api/seed
```

Expected room IDs:
- `VWRM0001`
- `VWRM0002`
- `VWRM0003`

## 6) Update deploy

```bash
git pull
pnpm install --frozen-lockfile
pnpm prisma migrate deploy
pnpm build
# restart process manager service
```

## 7) Quick recovery

```bash
# restart your process manager service
# or manually stop/start `pnpm start`
```
