# SpacetimeDB and VeriWire realtime

VeriWire keeps the **source of truth** for rooms, evidence, votes, and **rumour-room chat** in **Postgres** (e.g. Supabase) via Prisma. That gives you durable history, auth, and moderation hooks.

For **high concurrency and low-latency fan-out** (many users in the same room discussing proofs at once), the app also **publishes events** to an HTTP endpoint you control. Point `SPACETIMEDB_ENDPOINT` at a small service that forwards into SpacetimeDB (or any realtime bus).

## Events emitted today

| Event | When |
|--------|------|
| `audit.appended` | Any audit log row (existing) |
| `room.message.created` | New rumour-room chat or proof-thread message |
| `room.evidence.created` | New evidence / proof URL submitted |

Payloads are JSON: `{ roomId?, event, data, createdAt }` posted to `POST {SPACETIMEDB_ENDPOINT}/events` with optional `Authorization: Bearer {SPACETIMEDB_API_KEY}`.

## Recommended architecture

1. **VeriWire Next.js** — validates sessions, writes Postgres, publishes the events above.
2. **Bridge service** (your worker) — receives HTTP POST, calls SpacetimeDB **reducers** or inserts into replicated tables so connected clients get instant updates.
3. **SpacetimeDB module** (Rust) — tables such as `room_message` keyed by `room_id`, reducers like `append_message`, subscribers in the browser via the official [`spacetimedb`](https://www.npmjs.com/package/spacetimedb) TypeScript SDK (generate bindings with the SpacetimeDB CLI after you publish the module).

The UI already refreshes when `latestMessageAt` changes on the room SSE stream (`/api/rooms/:id/stream`), so users see new messages within the poll window even without a Spacetime client. Tightening latency is where SpacetimeDB subscriptions help.

## Env vars

- `SPACETIMEDB_ENDPOINT` — base URL of your ingest bridge (must expose `POST /events`).
- `SPACETIMEDB_API_KEY` — optional bearer token for the bridge.

Optional Supabase Storage or other side services are separate from this pipe; they use `SUPABASE_*` in the main app.

## Native SpacetimeDB module

Publish your own module following [SpacetimeDB’s module docs](https://spacetimedb.com/docs). Mirror the fields you care from `room.message.created` and `room.evidence.created` so client subscriptions stay in sync with Postgres (eventual consistency is acceptable if the bridge is reliable; for strict parity, treat Postgres as canonical and use Spacetime only for presence/live typing if you prefer).
