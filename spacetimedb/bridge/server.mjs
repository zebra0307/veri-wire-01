#!/usr/bin/env node

import http from "node:http";
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";

const MAX_BODY_BYTES = numberFromEnv("SPACETIME_BRIDGE_MAX_BODY_BYTES", 256000);
const HOST = process.env.SPACETIME_BRIDGE_HOST || "127.0.0.1";
const PORT = numberFromEnv("SPACETIME_BRIDGE_PORT", 8787);
const API_KEY = process.env.SPACETIME_BRIDGE_API_KEY || "";
const CLI_BIN = process.env.SPACETIME_CLI || "spacetime";
const CLI_SERVER = process.env.SPACETIME_SERVER || "http://127.0.0.1:3002";
const CLI_DATABASE = process.env.SPACETIME_DATABASE || "";
const CLI_REDUCER = process.env.SPACETIME_REDUCER || "ingest_event";
const CALL_TIMEOUT_MS = numberFromEnv("SPACETIME_CALL_TIMEOUT_MS", 6000);

if (!CLI_DATABASE) {
  console.error("[bridge] Missing SPACETIME_DATABASE");
  process.exit(1);
}

const server = http.createServer((request, response) => {
  void handleRequest(request, response);
});

server.listen(PORT, HOST, () => {
  console.log(`[bridge] Listening on http://${HOST}:${PORT}`);
  console.log(`[bridge] Forwarding to ${CLI_SERVER} database=${CLI_DATABASE} reducer=${CLI_REDUCER}`);
});

async function handleRequest(request, response) {
  try {
    if (request.method === "GET" && request.url === "/health") {
      return sendJson(response, 200, {
        ok: true,
        server: CLI_SERVER,
        database: CLI_DATABASE,
        reducer: CLI_REDUCER
      });
    }

    if (request.method !== "POST" || request.url !== "/events") {
      return sendJson(response, 404, {
        error: "Not found",
        detail: "Use POST /events"
      });
    }

    if (!isAuthorized(request, API_KEY)) {
      return sendJson(response, 401, {
        error: "Unauthorized",
        detail: "Missing or invalid bearer token"
      });
    }

    const body = await readJsonBody(request, MAX_BODY_BYTES);
    const payload = validatePayload(body);

    await callSpacetime(payload);

    return sendJson(response, 200, { ok: true });
  } catch (error) {
    const status = typeof error.status === "number" ? error.status : 502;
    const message = error instanceof Error ? error.message : "Bridge failure";
    return sendJson(response, status, { error: "Bridge failure", detail: message });
  }
}

function numberFromEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: expected positive number`);
  }

  return parsed;
}

function isAuthorized(request, expectedKey) {
  if (!expectedKey) {
    return true;
  }

  const authHeader = request.headers.authorization;
  if (typeof authHeader !== "string") {
    return false;
  }

  const [scheme, token] = authHeader.split(/\s+/, 2);
  if (!token || scheme.toLowerCase() !== "bearer") {
    return false;
  }

  const expected = Buffer.from(expectedKey);
  const provided = Buffer.from(token);

  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

function validatePayload(value) {
  if (!isObject(value)) {
    throw withStatus(400, "Payload must be a JSON object");
  }

  if (typeof value.event !== "string" || value.event.trim().length === 0) {
    throw withStatus(400, "Missing non-empty event field");
  }

  if (!isObject(value.data)) {
    throw withStatus(400, "Missing object data field");
  }

  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) {
    throw withStatus(400, "createdAt must be an ISO-8601 date string");
  }

  if (value.roomId != null && typeof value.roomId !== "string") {
    throw withStatus(400, "roomId must be a string when provided");
  }

  return {
    roomId: value.roomId,
    event: value.event,
    data: value.data,
    createdAt: value.createdAt
  };
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonBody(request, maxBodyBytes) {
  return new Promise((resolve, reject) => {
    let body = "";
    let bodyBytes = 0;
    let didReject = false;

    request.setEncoding("utf8");

    request.on("data", (chunk) => {
      bodyBytes += Buffer.byteLength(chunk);
      if (bodyBytes > maxBodyBytes) {
        didReject = true;
        reject(withStatus(413, `Payload exceeds limit of ${maxBodyBytes} bytes`));
        request.destroy();
        return;
      }

      body += chunk;
    });

    request.on("end", () => {
      if (didReject) {
        return;
      }

      if (!body.trim()) {
        reject(withStatus(400, "Missing JSON body"));
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(withStatus(400, "Invalid JSON body"));
      }
    });

    request.on("error", (error) => {
      if (!didReject) {
        reject(error);
      }
    });
  });
}

function callSpacetime(payload) {
  return new Promise((resolve, reject) => {
    const reducerArg = JSON.stringify(JSON.stringify(payload));
    const args = [
      "call",
      "--server",
      CLI_SERVER,
      CLI_DATABASE,
      CLI_REDUCER,
      reducerArg
    ];

    const child = spawn(CLI_BIN, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 300).unref();
      reject(withStatus(504, `spacetime call timed out after ${CALL_TIMEOUT_MS}ms`));
    }, CALL_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      reject(withStatus(502, `Failed to start spacetime CLI: ${error.message}`));
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);

      if (code === 0) {
        resolve();
        return;
      }

      const detail = (stderr || stdout).trim();
      reject(
        withStatus(
          502,
          detail
            ? `spacetime call failed (exit ${code}): ${detail.slice(0, 500)}`
            : `spacetime call failed with exit code ${code}`
        )
      );
    });
  });
}

function withStatus(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function sendJson(response, status, payload) {
  const encoded = JSON.stringify(payload);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(encoded);
}
