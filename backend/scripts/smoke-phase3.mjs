// Phase 3 smoke test — one-time booking, idempotency, cancellation, and races.
// Run: node scripts/smoke-phase3.mjs

const BASE = process.env.BASE ?? "http://localhost:4000";

function log(title, obj) {
  console.log(`\n=== ${title} ===`);
  console.log(typeof obj === "string" ? obj : JSON.stringify(obj, null, 2));
}
function assert(cond, msg) {
  if (!cond) {
    console.error(`ASSERT FAILED: ${msg}`);
    process.exit(1);
  }
  console.log(`  ✓ ${msg}`);
}
async function req(path, opts = {}, token, extraHeaders = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
      ...(opts.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, headers: Object.fromEntries(res.headers) };
}
const login = async (email) =>
  (
    await req("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password: "123456" }),
    })
  ).body.token;
const uuid = () =>
  "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });

async function main() {
  const patientToken = await login("patient@test.com");
  const patient2Token = await login("patient2@test.com");
  const therapistToken = await login("therapist@test.com");
  assert(patientToken && patient2Token && therapistToken, "logged in all 3");

  // Clean any leftover state from prior runs.
  await req("/holds/mine", { method: "DELETE" }, patientToken);
  await req("/holds/mine", { method: "DELETE" }, patient2Token);

  const therapists = (await req("/therapists", {}, patientToken)).body.therapists;
  const therapistId = therapists[0].id;

  const avail = await req(`/availability?therapistId=${therapistId}`, {}, patientToken);
  const availableSlots = avail.body.slots.filter((s) => s.status === "available");
  assert(availableSlots.length >= 4, "at least 4 available slots to work with");

  // --- SCENARIO 1: happy path booking + idempotency replay ---
  const slot1 = availableSlots[0];
  await req(
    "/holds",
    {
      method: "POST",
      body: JSON.stringify({ therapistId, startTime: slot1.startTime, endTime: slot1.endTime }),
    },
    patientToken
  );

  // Missing idempotency key → 400
  const noKey = await req(
    "/appointments",
    {
      method: "POST",
      body: JSON.stringify({ therapistId, startTime: slot1.startTime, endTime: slot1.endTime }),
    },
    patientToken
  );
  log("POST /appointments (no Idempotency-Key)", noKey);
  assert(noKey.status === 400, "missing Idempotency-Key rejected");

  const key1 = uuid();
  const book1 = await req(
    "/appointments",
    {
      method: "POST",
      body: JSON.stringify({ therapistId, startTime: slot1.startTime, endTime: slot1.endTime }),
    },
    patientToken,
    { "Idempotency-Key": key1 }
  );
  log("POST /appointments (1st)", book1);
  assert(book1.status === 201, "booking created");
  assert(book1.body.appointment?.status === "scheduled", "status scheduled");
  const apptId1 = book1.body.appointment.id;

  // Idempotent replay — same key, same body → cached 201
  const replay = await req(
    "/appointments",
    {
      method: "POST",
      body: JSON.stringify({ therapistId, startTime: slot1.startTime, endTime: slot1.endTime }),
    },
    patientToken,
    { "Idempotency-Key": key1 }
  );
  log("POST /appointments (replay same key)", { status: replay.status, replay: replay.headers["idempotent-replay"], id: replay.body.appointment?.id });
  assert(replay.status === 201, "replay returns same 201");
  assert(replay.body.appointment.id === apptId1, "replay returns SAME appointment id");
  assert(replay.headers["idempotent-replay"] === "true", "Idempotent-Replay header set");

  // Different Idempotency-Key for the same (already-booked) slot → 410 (hold gone) OR 409 (slot booked)
  // First re-establish a hold to isolate the error path. We can't — the slot is booked. Skipping direct
  // second-attempt without hold; conflict is exercised in SCENARIO 2 with race.

  // --- SCENARIO 2: cross-patient race for the same slot ---
  const slot2 = availableSlots[1];
  // Both patients try to hold + book slot2 concurrently. Only one can even acquire the hold.
  const raceSetup = await Promise.allSettled([
    req(
      "/holds",
      {
        method: "POST",
        body: JSON.stringify({ therapistId, startTime: slot2.startTime, endTime: slot2.endTime }),
      },
      patientToken
    ),
    req(
      "/holds",
      {
        method: "POST",
        body: JSON.stringify({ therapistId, startTime: slot2.startTime, endTime: slot2.endTime }),
      },
      patient2Token
    ),
  ]);
  const winners = raceSetup.map((r) => r.value.status);
  log("Simultaneous /holds for same slot (statuses)", winners);
  assert(winners.filter((s) => s === 201).length === 1, "exactly one patient wins the hold");
  assert(winners.filter((s) => s === 409).length === 1, "the other gets 409");

  // The winner then books. The loser tries to book (they have no hold) → should get 410 or 409.
  const winnerIdx = raceSetup[0].value.status === 201 ? 0 : 1;
  const winnerToken = winnerIdx === 0 ? patientToken : patient2Token;
  const loserToken = winnerIdx === 0 ? patient2Token : patientToken;

  const bookRace = await Promise.allSettled([
    req(
      "/appointments",
      {
        method: "POST",
        body: JSON.stringify({ therapistId, startTime: slot2.startTime, endTime: slot2.endTime }),
      },
      winnerToken,
      { "Idempotency-Key": uuid() }
    ),
    req(
      "/appointments",
      {
        method: "POST",
        body: JSON.stringify({ therapistId, startTime: slot2.startTime, endTime: slot2.endTime }),
      },
      loserToken,
      { "Idempotency-Key": uuid() }
    ),
  ]);
  const raceStatuses = bookRace.map((r) => r.value.status);
  log("Simultaneous /appointments for same slot", { statuses: raceStatuses, bodies: bookRace.map((r) => r.value.body) });
  assert(raceStatuses.filter((s) => s === 201).length === 1, "exactly one booking succeeds");
  assert(raceStatuses.some((s) => s === 410 || s === 409), "the other gets 409/410");

  // --- SCENARIO 3: patient double-clicks (same key, concurrent) → single appointment ---
  // Give patient A a fresh hold on slot3, then fire two identical requests in parallel.
  await req("/holds/mine", { method: "DELETE" }, patientToken);
  await req("/holds/mine", { method: "DELETE" }, patient2Token);
  const slot3 = availableSlots[2];
  await req(
    "/holds",
    {
      method: "POST",
      body: JSON.stringify({ therapistId, startTime: slot3.startTime, endTime: slot3.endTime }),
    },
    patientToken
  );
  const key3 = uuid();
  const doubleClick = await Promise.all([
    req(
      "/appointments",
      {
        method: "POST",
        body: JSON.stringify({ therapistId, startTime: slot3.startTime, endTime: slot3.endTime }),
      },
      patientToken,
      { "Idempotency-Key": key3 }
    ),
    req(
      "/appointments",
      {
        method: "POST",
        body: JSON.stringify({ therapistId, startTime: slot3.startTime, endTime: slot3.endTime }),
      },
      patientToken,
      { "Idempotency-Key": key3 }
    ),
  ]);
  log("Double-click same idempotency key", doubleClick.map((r) => ({ status: r.status, id: r.body.appointment?.id, replay: r.headers["idempotent-replay"] })));
  assert(
    doubleClick[0].status === 201 && doubleClick[1].status === 201,
    "both requests get 201"
  );
  assert(
    doubleClick[0].body.appointment.id === doubleClick[1].body.appointment.id,
    "both requests return the SAME appointment id (idempotency)"
  );

  // Verify DB has only ONE appointment for slot3 (not 2)
  const list = await req("/appointments", {}, patientToken);
  const slot3Rows = list.body.appointments.filter(
    (a) => a.startTime === slot3.startTime && a.status !== "cancelled"
  );
  assert(slot3Rows.length === 1, "exactly one appointment row for slot3 despite double-click");

  // --- SCENARIO 4: cancel → slot bookable again ---
  const cancel = await req(`/appointments/${apptId1}`, { method: "DELETE" }, patientToken);
  log("DELETE /appointments/:id", cancel);
  assert(cancel.status === 200 && cancel.body.appointment.status === "cancelled", "cancel works");

  // Availability shows slot1 available again
  const avail2 = await req(`/availability?therapistId=${therapistId}`, {}, patientToken);
  const slot1After = avail2.body.slots.find((s) => s.startTime === slot1.startTime);
  log("availability of slot1 after cancel", slot1After);
  assert(slot1After.status === "available", "slot bookable again after cancel");

  // Cancel someone else's appointment → 403
  const notMine = await req(`/appointments/${doubleClick[0].body.appointment.id}`, { method: "DELETE" }, patient2Token);
  log("Patient B cancelling Patient A's appointment", notMine);
  assert(notMine.status === 403, "cannot cancel someone else's appointment");

  // --- SCENARIO 5: booking without a hold → 410 ---
  await req("/holds/mine", { method: "DELETE" }, patientToken);
  const noHold = await req(
    "/appointments",
    {
      method: "POST",
      body: JSON.stringify({ therapistId, startTime: slot1.startTime, endTime: slot1.endTime }),
    },
    patientToken,
    { "Idempotency-Key": uuid() }
  );
  log("Booking with no hold", noHold);
  assert(noHold.status === 410 || noHold.status === 409, "booking without hold rejected (410/409)");

  console.log("\nALL PHASE 3 CHECKS PASSED ✓");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
