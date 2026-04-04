# VeriWire

VeriWire is a collaborative misinformation resolution platform with room-based investigation, bounded agent research, weighted voting, and Clarity Card output.

## Stack

- Frontend: Next.js 14, App Router, TypeScript, Tailwind
- Persistence: PostgreSQL (Prisma)
- Realtime-style updates: polling room + agent events endpoints
- Auth: NextAuth (Email magic link + GitHub OAuth)
- AI: Gemini 1.5 Pro (fallback-safe)
- Infra: Docker Compose (next-app, postgres, redis, caddy)

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

2. Start local PostgreSQL and Redis (or use Docker Compose).

3. Run migrations and seed:

```bash
pnpm prisma migrate dev
pnpm prisma db seed
```

4. Start app:

```bash
pnpm dev
```

5. Open:

- App: http://localhost:3000
- Health: http://localhost:3000/api/health

## Demo seed rooms

- `VWRM0001` INVESTIGATING
- `VWRM0002` PENDING_VERDICT
- `VWRM0003` CLOSED FALSE with Clarity Card

## Production deployment (Vultr VPS)

1. Create `.env.production` from `.env.production.example`.
2. Set:
   - `DOMAIN`
   - `NEXTAUTH_URL`
   - `POSTGRES_PASSWORD`
   - `NEXTAUTH_SECRET`
   - OAuth/email/Gemini keys
3. Deploy:

```bash
docker compose up -d --build
```

4. Verify:

```bash
curl -s https://$DOMAIN/api/health
```

## Notes

- Agent route `/api/rooms/[roomId]/agent/run` is internal-secret gated.
- Clarity card files are represented as app paths for demo mode.
- Observer demo flow can be enabled with `DEMO_BYPASS_AUTH=true`.

## Live updates

- Client subscribes to SSE stream at `/api/rooms/:roomId/stream`.
- Stream emits `room.update` payload markers whenever room/evidence/vote/agent/audit state changes.
- If `SPACETIMEDB_ENDPOINT` is configured, audit events are also mirrored to your managed SpacetimeDB event ingest path.

## SuperPlane integration

- Room creation and room close transitions dispatch `claim.created` and `room.closed` workflow events.
- If `SUPERPLANE_WEBHOOK_URL` is set, events are sent remotely.
- If remote dispatch fails (or URL not set), local fallback executes the same workflow handlers.
- Optional secure inbound endpoint for orchestration callbacks: `/api/superplane/events` with `x-superplane-secret`.
