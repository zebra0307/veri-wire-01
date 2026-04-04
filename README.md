# VeriWire

VeriWire is a collaborative misinformation resolution platform with room-based investigation, bounded agent research, weighted voting, and Clarity Card output.

## Supabase setup (database)

1. Create a [Supabase](https://supabase.com) project.
2. Open **Project Settings → Database** and copy the **URI** connection string (Postgres).
3. Put it in `DATABASE_URL` in `.env.local` (or `.env.production` for Docker).
4. Apply the schema to that database from your machine (recommended first-time):

```bash
cp .env.example .env.local
# edit DATABASE_URL, NEXTAUTH_SECRET, OAuth or DEMO_BYPASS_AUTH

pnpm install
pnpm prisma generate
pnpm prisma db push
pnpm prisma db seed   # optional sample data
```

**Prisma + Supabase pooler:** If you use the pooler port, append query params as in Supabase’s Prisma docs (for example `?pgbouncer=true&connection_limit=1` for transaction mode).

Optional **Supabase platform APIs** (Storage, etc.): set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`; use `getSupabaseAdmin()` in `src/lib/supabase-server.ts`. Row data still goes through **Prisma** and `DATABASE_URL`.

## Authentication

- **Production / real use:** Set `DEMO_BYPASS_AUTH=false`, configure **GitHub** and/or **email (SMTP)** in env, and sign in at `/login`.
- **Local quick demo:** Set `DEMO_BYPASS_AUTH=true` to use a synthetic demo moderator (no OAuth). Demo seed rooms: `curl -X POST http://localhost:3000/api/seed` (only when demo bypass is on).

## Demo first (optional, ~5 minutes)

1. In `.env.local`: `DEMO_BYPASS_AUTH=true` and a valid `DATABASE_URL` (Supabase).
2. `pnpm prisma db push && pnpm prisma db seed` (or start app and `POST /api/seed`).
3. `pnpm dev` → http://localhost:3000
4. Smoke (with demo bypass so `/api/rooms` is allowed):

```bash
pnpm smoke
```

Expected demo room IDs after seed: `VWRM0001`, `VWRM0002`, `VWRM0003`.

## Stack

- Frontend: Next.js 14, App Router, TypeScript, Tailwind
- Persistence: Postgres via **Prisma** (hosted on **Supabase**)
- Realtime-style updates: polling room + agent events endpoints; optional SSE
- Auth: NextAuth (Email magic link + GitHub OAuth)
- AI: Gemini 1.5 Pro (fallback-safe)
- Infra: Docker Compose (next-app, redis, caddy) — database is external (Supabase)

## Security implemented

- Session validation in API routes before protected reads/writes
- Room-level authorization (`OWNER`, `CONTRIBUTOR`, `VOTER`, `OBSERVER`)
- Zod validation + server-side sanitization
- Claim max length 1000, evidence snippet max 300
- URL safety checks and source block rules
- Image MIME + size policy hooks (reject SVG, max 5MB)
- Agent blocked-rule enforcement and structured `BLOCKED` responses
- Rate limits: claims, evidence, votes, agent runs
- Immutable audit log (append-only writes)
- PII detection (email/phone/Aadhaar) and moderation flags

## Local run

1. Copy env file:

```bash
cp .env.example .env.local
```

2. Set `DATABASE_URL` (Supabase), `NEXTAUTH_SECRET`, and either OAuth credentials or `DEMO_BYPASS_AUTH=true`.

3. Push schema and optional seed:

```bash
pnpm prisma db push
pnpm prisma db seed
```

4. Start app:

```bash
pnpm dev
```

5. Open:

- App: http://localhost:3000
- Sign in: http://localhost:3000/login
- Health: http://localhost:3000/api/health

## Docker Compose (app + Redis + Caddy)

Compose **does not** run Postgres. Set `DATABASE_URL` in `.env.production` to your Supabase URI before `docker compose up`.

```bash
cp .env.production.example .env.production
# set DATABASE_URL, NEXTAUTH_*, DOMAIN, etc.

docker compose --env-file .env.production up -d --build
```

After the first deploy, ensure the schema exists on Supabase (run `pnpm prisma db push` or `prisma migrate deploy` from CI against the same `DATABASE_URL`).

## Production deployment (Vultr VPS)

1. Create `.env.production` from `.env.production.example`.
2. Set `DOMAIN`, `NEXTAUTH_URL`, `DATABASE_URL` (Supabase), `NEXTAUTH_SECRET`, OAuth/email/Gemini keys.
3. Deploy:

```bash
docker compose --env-file .env.production up -d --build
```

4. Verify:

```bash
curl -s https://$DOMAIN/api/health
```

## Notes

- Agent route `/api/rooms/[roomId]/agent/run` is internal-secret gated.
- Clarity card files are represented as app paths for demo mode.
- Observer demo flow: with `DEMO_BYPASS_AUTH=true`, seed creates `observer@veriwire.demo` (read-only) vs moderator contributor behavior.

## Live updates

- Client subscribes to SSE stream at `/api/rooms/:roomId/stream`.
- Stream emits `room.patch` payload snapshots when room/evidence/votes/agent/audit/**rumour-room messages** change (`latestMessageAt` is part of the patch marker).
- **Rumour room:** per-room discussion and proof-thread notes live in Postgres (`RoomMessage`); `POST /api/rooms/:roomId/messages` and the room detail payload include the latest messages.
- **SpacetimeDB:** optional HTTP bridge via `SPACETIMEDB_ENDPOINT` — see [`spacetimedb/README.md`](./spacetimedb/README.md). Events include `room.message.created`, `room.evidence.created`, and `audit.appended` for high-concurrency fan-out to SpacetimeDB clients.

## Heat score recalculation

- Feed reads trigger opportunistic 5-minute heat-score recalculation.
- You can also trigger recalculation manually:

```bash
curl -X POST https://$DOMAIN/api/system/heat/recalculate -H "x-internal-secret: $INTERNAL_AGENT_SECRET"
```

## Image claim uploads

- Secure upload endpoint: `/api/uploads/image` (authenticated).
- Server validates MIME (`jpeg/png/webp`) and size (`<=5MB`) and blocks SVG.

## SuperPlane integration

- Room creation and room close transitions dispatch `claim.created` and `room.closed` workflow events.
- If `SUPERPLANE_WEBHOOK_URL` is set, events are sent remotely.
- If remote dispatch fails (or URL not set), local fallback executes the same workflow handlers.
- Optional secure inbound endpoint for orchestration callbacks: `/api/superplane/events` with `x-superplane-secret`.
