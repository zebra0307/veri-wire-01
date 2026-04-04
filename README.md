# VeriWire

VeriWire is a collaborative misinformation resolution platform with room-based investigation, bounded agent research, weighted voting, and clarity card output.

## Local-first setup (no Docker)

1. Copy env template:

```bash
cp .env.example .env.local
```

2. Configure these values in `.env.local`:
- `DATABASE_URL` (Supabase Postgres URI, or local Postgres at `127.0.0.1:5432`)
- `NEXTAUTH_SECRET`
- `NEXTAUTH_URL` (usually `http://localhost:3000`)
- Set either OAuth/email credentials, or use `DEMO_BYPASS_AUTH=true` for local demo mode.

3. Install and prepare database:

```bash
pnpm install
pnpm prisma generate
pnpm prisma db push
pnpm prisma db seed
```

4. Run the app:

```bash
pnpm dev
```

5. Open:
- App: http://localhost:3000
- Login: http://localhost:3000/login
- Health: http://localhost:3000/api/health

## Demo mode

For quick local testing:
- Set `DEMO_BYPASS_AUTH=true`
- Seed deterministic rooms:

```bash
curl -X POST -sS http://localhost:3000/api/seed
```

Expected seeded rooms:
- `VWRM0001`
- `VWRM0002`
- `VWRM0003`

## Stack

- Frontend: Next.js 14, App Router, TypeScript, Tailwind
- Persistence: Prisma + Postgres (Supabase recommended)
- Auth: NextAuth (GitHub OAuth + email)
- AI: Gemini + bounded agent pipeline
- Realtime: SSE room stream + optional SpacetimeDB bridge

## Local production run (no Docker)

```bash
pnpm build
pnpm start
```

Then verify:

```bash
curl -sS http://localhost:3000/api/health
pnpm smoke
```

If app is not running on `localhost:3000`:

```bash
SMOKE_BASE_URL="https://your-domain" pnpm smoke
```

## Notes

- Agent run route `/api/rooms/[roomId]/agent/run` is internal-secret gated.
- With `GEMINI_API_KEY`, agent web retrieval uses Gemini grounding search by default.
- `BRAVE_SEARCH_API_KEY` is optional. If Gemini grounding is unavailable and Brave is missing, agent web retrieval falls back to DuckDuckGo public search.
- Room stream emits `room.patch` snapshots including message updates.
- Optional external event fan-out can use `SPACETIMEDB_ENDPOINT`.
- `REDIS_URL` is optional. If unavailable, local in-memory fallback is used for rate limits.
