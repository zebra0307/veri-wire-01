# VeriWire Spacetime Bridge

This bridge exposes `POST /events` and forwards each event to a SpacetimeDB reducer using the Spacetime CLI.

It is intended to satisfy the app contract in `src/lib/spacetime.ts`, where VeriWire publishes JSON payloads like:

```json
{
  "roomId": "optional-room-id",
  "event": "room.message.created",
  "data": { "id": "..." },
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

## Prerequisites

- SpacetimeDB server running (for local default: `http://127.0.0.1:3002`)
- `spacetime` CLI installed and on `PATH`
- A published Spacetime database with a reducer that accepts **one JSON string argument**

Default reducer name used by the bridge: `ingest_event`.

## Run

From the repo root:

```bash
export SPACETIME_SERVER=http://127.0.0.1:3002
export SPACETIME_DATABASE=veriwire
export SPACETIME_REDUCER=ingest_event
export SPACETIME_BRIDGE_API_KEY=dev-bridge-key
pnpm spacetime:bridge
```

Bridge defaults:

- Host: `127.0.0.1`
- Port: `8787`
- Route: `POST /events`
- Health: `GET /health`

## Point VeriWire at the bridge

In `.env.local`:

```bash
SPACETIMEDB_ENDPOINT=http://127.0.0.1:8787
SPACETIMEDB_API_KEY=dev-bridge-key
```

Restart `pnpm dev` after changing env values.

## Test the bridge directly

```bash
curl -i http://127.0.0.1:8787/events \
  -X POST \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer dev-bridge-key' \
  --data '{"event":"room.message.created","createdAt":"2026-01-01T00:00:00.000Z","roomId":"room_1","data":{"id":"msg_1"}}'
```

Expected response:

```json
{"ok":true}
```

If your reducer name/signature is different, set `SPACETIME_REDUCER` accordingly.

## Environment variables

- `SPACETIME_DATABASE` (required): target Spacetime database name or identity
- `SPACETIME_SERVER` (optional): default `http://127.0.0.1:3002`
- `SPACETIME_REDUCER` (optional): default `ingest_event`
- `SPACETIME_CLI` (optional): CLI executable name, default `spacetime`
- `SPACETIME_BRIDGE_HOST` (optional): default `127.0.0.1`
- `SPACETIME_BRIDGE_PORT` (optional): default `8787`
- `SPACETIME_BRIDGE_API_KEY` (optional): bearer token required by `POST /events`
- `SPACETIME_CALL_TIMEOUT_MS` (optional): CLI timeout, default `6000`
- `SPACETIME_BRIDGE_MAX_BODY_BYTES` (optional): request body size limit, default `256000`
