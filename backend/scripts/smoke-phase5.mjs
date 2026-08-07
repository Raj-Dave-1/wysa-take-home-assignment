// Phase 5 smoke test — therapist appointment list, status update (window-guarded),
// and schedule update (must not affect existing appointments).
// Run: node scripts/smoke-phase5.mjs

import pg from "pg";
const { Client } = pg;

const BASE = process.env.BASE ?? "http://localhost:4000";
const PG_URL = process.env.DATABASE_URL ?? "postgres://wysa:wysa@localhost:5433/wysa";

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
  const therapistToken = await login("therapist@test.com");
  assert(patientToken && therapistToken, "logged in patient + therapist");

  await req("/holds/mine", { method: "DELETE" }, patientToken);

  // --- Book a fresh one-time appointment we'll manipulate for the window tests ---
  const therapists = (await req("/therapists", {}, patientToken)).body.therapists;
  const therapistId = therapists[0].id;

  const avail = await req(`/availability?therapistId=${therapistId}`, {}, patientToken);
  const openSlots = avail.body.slots.filter((s) => s.status === "available");
  assert(openSlots.length >= 1, "at least one available slot");
  const anchor = openSlots[0];

  await req(
    "/holds",
    {
      method: "POST",
      body: JSON.stringify({
        therapistId,
        startTime: anchor.startTime,
        endTime: anchor.endTime,
      }),
    },
    patientToken
  );
  const book = await req(
    "/appointments",
    {
      method: "POST",
      body: JSON.stringify({
        therapistId,
        startTime: anchor.startTime,
        endTime: anchor.endTime,
      }),
    },
    patientToken,
    { "Idempotency-Key": uuid() }
  );
  assert(book.status === 201, "booked test appointment");
  const apptId = book.body.appointment.id;

  // --- SCENARIO 1: GET /therapist/appointments returns joined patient info ---
  const list = await req("/therapist/appointments", {}, therapistToken);
  log("GET /therapist/appointments", { count: list.body.appointments.length, first: list.body.appointments[0] });
  assert(list.status === 200, "list 200");
  const mine = list.body.appointments.find((a) => a.id === apptId);
  assert(mine, "the test appointment appears in the therapist list");
  assert(typeof mine.patientName === "string" && mine.patientName.length > 0, "patient name populated");

  // Patient can't call therapist route → 403
  const forbidden = await req("/therapist/appointments", {}, patientToken);
  log("patient calling /therapist/appointments", forbidden);
  assert(forbidden.status === 403, "patient forbidden from therapist route");

  // --- SCENARIO 2: PATCH status BEFORE the window is open → 400 ---
  const tooEarly = await req(
    `/appointments/${apptId}/status`,
    { method: "PATCH", body: JSON.stringify({ status: "completed" }) },
    therapistToken
  );
  log("PATCH status before window opens", tooEarly);
  assert(tooEarly.status === 400, "status update blocked outside window");

  // --- SCENARIO 3: backdate the row into the current window, then PATCH ---
  const pgClient = new Client({ connectionString: PG_URL });
  await pgClient.connect();
  await pgClient.query(
    `UPDATE appointments SET start_time = NOW() - INTERVAL '1 minute', end_time = NOW() + INTERVAL '30 minutes' WHERE id = $1`,
    [apptId]
  );

  // Patient can't update status (only therapist)
  const patientTryStatus = await req(
    `/appointments/${apptId}/status`,
    { method: "PATCH", body: JSON.stringify({ status: "completed" }) },
    patientToken
  );
  log("patient PATCH status", patientTryStatus);
  assert(patientTryStatus.status === 403, "patient cannot update status");

  // Therapist updates → 200
  const setCompleted = await req(
    `/appointments/${apptId}/status`,
    { method: "PATCH", body: JSON.stringify({ status: "completed" }) },
    therapistToken
  );
  log("PATCH status (completed, in window)", setCompleted);
  assert(setCompleted.status === 200, "status updated in window");
  assert(setCompleted.body.appointment.status === "completed", "status is completed");

  // --- SCENARIO 4: cannot transition FROM terminal status ---
  const tryReupdate = await req(
    `/appointments/${apptId}/status`,
    { method: "PATCH", body: JSON.stringify({ status: "no_show" }) },
    therapistToken
  );
  log("re-PATCH terminal status", tryReupdate);
  assert(tryReupdate.status === 400, "cannot transition from completed");

  // --- SCENARIO 5: schedule update MUST NOT affect existing appointments ---
  // Snapshot current appointment count + a sample appointment before schedule change.
  const preList = (await req("/therapist/appointments", {}, therapistToken)).body.appointments;
  const preSnapshot = preList.map((a) => ({ id: a.id, startTime: a.startTime, status: a.status }));

  // Get current schedule so we can restore it later.
  const currentSchedule = (await req("/therapist/schedule", {}, therapistToken)).body.schedule.map((s) => ({
    dayOfWeek: s.dayOfWeek,
    startTime: s.startTime.slice(0, 5),
    endTime: s.endTime.slice(0, 5),
  }));

  // Replace with a completely different, minimal schedule (Sundays only).
  const put = await req(
    "/therapist/schedule",
    {
      method: "PUT",
      body: JSON.stringify({
        schedule: [
          { dayOfWeek: 0, startTime: "08:00", endTime: "09:00" },
          { dayOfWeek: 0, startTime: "09:00", endTime: "10:00" },
        ],
      }),
    },
    therapistToken
  );
  log("PUT /therapist/schedule (Sundays only)", put);
  assert(put.status === 200 && put.body.updated === 2, "schedule replaced with 2 rows");

  // The old (Thursday/Friday etc.) appointments must still exist unchanged.
  const postList = (await req("/therapist/appointments", {}, therapistToken)).body.appointments;
  assert(postList.length === preList.length, "appointment count unchanged after schedule replace");
  const preIds = new Set(preSnapshot.map((a) => a.id));
  const postIds = new Set(postList.map((a) => a.id));
  assert([...preIds].every((id) => postIds.has(id)), "every prior appointment id still present");
  for (const p of preSnapshot) {
    const q = postList.find((a) => a.id === p.id);
    assert(q.startTime === p.startTime, `appointment ${p.id.slice(0, 8)} start_time unchanged`);
    assert(q.status === p.status, `appointment ${p.id.slice(0, 8)} status unchanged`);
  }

  // Availability now only shows Sunday slots (in the requested window).
  const availAfter = await req(`/availability?therapistId=${therapistId}`, {}, patientToken);
  const uniqueDays = new Set(
    availAfter.body.slots.map((s) => new Date(s.startTime).getUTCDay())
  );
  log("availability days-of-week after schedule change", [...uniqueDays]);
  // Because our timezone shift + week window, we may see the Sunday inside the 7-day window.
  // The important assertion: NO day in the new availability corresponds to old Mon/Tue/Thu/Fri.
  const oldDays = new Set([1, 2, 4, 5]);
  const anyOldDaysAvailable = availAfter.body.slots.some((s) => {
    // Compute the day-of-week in APP_TZ (server uses Asia/Kolkata).
    const iso = s.startTime;
    // shift by +05:30
    const t = new Date(new Date(iso).getTime() + 330 * 60 * 1000);
    return oldDays.has(t.getUTCDay());
  });
  assert(!anyOldDaysAvailable, "no slots on old Mon/Tue/Thu/Fri days after schedule change");

  // Restore the original schedule so subsequent smoke tests aren't polluted.
  const restore = await req(
    "/therapist/schedule",
    { method: "PUT", body: JSON.stringify({ schedule: currentSchedule }) },
    therapistToken
  );
  assert(restore.status === 200, "schedule restored");

  // --- SCENARIO 6: schedule validation ---
  const overlapping = await req(
    "/therapist/schedule",
    {
      method: "PUT",
      body: JSON.stringify({
        schedule: [
          { dayOfWeek: 1, startTime: "10:00", endTime: "11:00" },
          { dayOfWeek: 1, startTime: "10:30", endTime: "12:00" }, // overlaps
        ],
      }),
    },
    therapistToken
  );
  log("PUT /therapist/schedule (overlapping)", overlapping);
  assert(overlapping.status === 400, "overlapping windows rejected");

  const inverted = await req(
    "/therapist/schedule",
    {
      method: "PUT",
      body: JSON.stringify({
        schedule: [{ dayOfWeek: 1, startTime: "12:00", endTime: "11:00" }],
      }),
    },
    therapistToken
  );
  log("PUT /therapist/schedule (inverted times)", inverted);
  assert(inverted.status === 400, "inverted times rejected");

  await pgClient.end();
  console.log("\nALL PHASE 5 CHECKS PASSED ✓");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
