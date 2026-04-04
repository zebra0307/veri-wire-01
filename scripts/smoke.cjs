#!/usr/bin/env node

const BASE_URL = (process.env.SMOKE_BASE_URL || process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");

async function request(path, init) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init && init.headers ? init.headers : {})
    }
  });

  let data = null;
  const text = await response.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  return { response, data };
}

async function assertJson(path, init, validate, errorMessage) {
  const { response, data } = await request(path, init);

  if (!response.ok) {
    throw new Error(`${errorMessage} (status ${response.status})`);
  }

  const isValid = validate(data);
  if (!isValid) {
    throw new Error(`${errorMessage} (unexpected payload)`);
  }

  return data;
}

async function checkSse(roomId) {
  const streamResponse = await fetch(`${BASE_URL}/api/rooms/${roomId}/stream`, {
    headers: {
      Accept: "text/event-stream"
    }
  });

  if (!streamResponse.ok || !streamResponse.body) {
    throw new Error(`SSE stream failed (status ${streamResponse.status})`);
  }

  const reader = streamResponse.body.getReader();

  try {
    const readPromise = reader.read();
    const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 5000));
    const result = await Promise.race([readPromise, timeoutPromise]);

    if (result && result.timeout) {
      throw new Error("SSE stream timed out waiting for first event chunk");
    }

    if (!result || result.done || !result.value) {
      throw new Error("SSE stream closed before emitting events");
    }

    const chunk = Buffer.from(result.value).toString("utf8");
    if (!chunk.includes("event: stream.ready") && !chunk.includes("event: room.patch")) {
      throw new Error("SSE stream did not emit expected stream.ready or room.patch event");
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Ignore stream cleanup issues during smoke checks.
    }
  }
}

async function run() {
  console.log(`Smoke check base URL: ${BASE_URL}`);

  await assertJson(
    "/api/health",
    undefined,
    (data) => data && data.ok === true,
    "Health endpoint check failed"
  );
  console.log("- /api/health ok");

  const seedAttempt = await request("/api/seed", { method: "POST" });
  if (seedAttempt.response.ok) {
    console.log("- /api/seed ok");
  } else if (seedAttempt.response.status === 403 || seedAttempt.response.status === 404) {
    console.log(`- /api/seed skipped (status ${seedAttempt.response.status})`);
  } else {
    throw new Error(`/api/seed failed with status ${seedAttempt.response.status}`);
  }

  const roomsRequest = await request("/api/rooms");
  if (roomsRequest.response.status === 401) {
    throw new Error(
      "GET /api/rooms returned 401. For smoke tests set DEMO_BYPASS_AUTH=true or sign in (cookies). Production should keep DEMO_BYPASS_AUTH=false."
    );
  }
  if (!roomsRequest.response.ok) {
    throw new Error(`Rooms feed check failed (status ${roomsRequest.response.status})`);
  }
  const roomsPayload = roomsRequest.data;
  if (!roomsPayload || !Array.isArray(roomsPayload.rooms) || roomsPayload.rooms.length < 1) {
    throw new Error("Rooms feed check failed (unexpected payload or empty feed)");
  }
  console.log(`- /api/rooms ok (${roomsPayload.rooms.length} rooms)`);

  const preferredRoom =
    roomsPayload.rooms.find((room) => room.id === "VWRM0002") || roomsPayload.rooms[0];

  if (!preferredRoom || !preferredRoom.id) {
    throw new Error("No valid room id found in /api/rooms response");
  }

  await assertJson(
    `/api/rooms/${preferredRoom.id}`,
    undefined,
    (data) => data && data.room && data.room.id === preferredRoom.id,
    "Room detail check failed"
  );
  console.log(`- /api/rooms/${preferredRoom.id} ok`);

  await checkSse(preferredRoom.id);
  console.log(`- /api/rooms/${preferredRoom.id}/stream ok`);

  console.log("Smoke checks passed.");
}

run().catch((error) => {
  console.error(`Smoke checks failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
