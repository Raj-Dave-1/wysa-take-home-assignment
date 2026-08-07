// Phase 2 smoke test — exercises therapists, availability, and holds.
// Run: node scripts/smoke-phase2.mjs   (from backend/)

const BASE = process.env.BASE ?? "http://localhost:4000";

function log(title, obj) {
  console.log(`\n=== ${title} ===`);
  console.log(typeof obj === "string" ? obj : JSON.stringify(obj, null, 2));
}

async function req(path, opts = {}, token) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`ASSERT FAILED: ${msg}`);
    process.exit(1);
  }
  console.log(`  ✓ ${msg}`);
}

async function main() {
  const login = async (email) =>
    (await req("/auth/login", { method: "POST", body: JSON.stringify({ email, password: "123456" }) })).body.token;

  const patientToken = await login("patient@test.com");
  const patient2Token = await login("patient2@test.com");
  const therapistToken = await login("therapist@test.com");
  assert(patientToken && patient2Token && therapistToken, "logged in both patients + therapist");

  // Clean any leftover holds from a prior run so the test is deterministic.
  await req("/holds/mine", { method: "DELETE" }, patientToken);
  await req("/holds/mine", { method: "DELETE" }, patient2Token);

  // 2. list therapists
  const list = await req("/therapists", {}, patientToken);
  log("GET /therapists", list.body);
  assert(list.status === 200 && list.body.therapists.length >= 1, "at least one therapist");
  const therapistId = list.body.therapists[0].id;

  // 3. read schedule
  const sched = await req(`/therapists/${therapistId}/schedule`, {}, patientToken);
  log("GET /therapists/:id/schedule", { count: sched.body.schedule.length, first: sched.body.schedule[0] });
  assert(sched.body.schedule.length === 15, "15 schedule rows seeded");

  // 4. availability — next 7 days
  const avail = await req(`/availability?therapistId=${therapistId}`, {}, patientToken);
  log("GET /availability (default 7 days)", { tz: avail.body.timezone, count: avail.body.slots.length, first3: avail.body.slots.slice(0, 3) });
  assert(avail.status === 200, "availability 200");
  assert(avail.body.slots.length > 0, "generated at least one slot");
  assert(avail.body.slots.every(s => s.status === "available"), "all fresh slots available");

  // 5. hold the first available slot
  const target = avail.body.slots[0];
  const hold1 = await req(
    "/holds",
    { method: "POST", body: JSON.stringify({ therapistId, startTime: target.startTime, endTime: target.endTime }) },
    patientToken
  );
  log("POST /holds", hold1);
  assert(hold1.status === 201, "hold created");
  assert(hold1.body.hold.remainingSeconds > 0 && hold1.body.hold.remainingSeconds <= 60, "TTL within (0,60]");

  // 6. GET /holds/mine — refresh survival
  const mine = await req("/holds/mine", {}, patientToken);
  log("GET /holds/mine", mine.body);
  assert(mine.status === 200 && mine.body.hold?.startTime === target.startTime, "hold survives via /holds/mine");

  // 7. try to double-hold same patient — should 409
  const holdAgain = await req(
    "/holds",
    {
      method: "POST",
      body: JSON.stringify({
        therapistId,
        startTime: avail.body.slots[1].startTime,
        endTime: avail.body.slots[1].endTime,
      }),
    },
    patientToken
  );
  log("POST /holds (same patient, 2nd hold)", holdAgain);
  assert(holdAgain.status === 409, "second hold rejected with 409");

  // 8. availability again — the held slot should show held_by_me
  const avail2 = await req(`/availability?therapistId=${therapistId}`, {}, patientToken);
  const targetSlotNow = avail2.body.slots.find(s => s.startTime === target.startTime);
  log("availability after hold", targetSlotNow);
  assert(targetSlotNow.status === "held_by_me", "held slot shows held_by_me for owner");

  // 9. therapist calling availability sees held_by_other (not held_by_me)
  const availAsTherapist = await req(`/availability?therapistId=${therapistId}`, {}, therapistToken);
  const targetAsTherapist = availAsTherapist.body.slots.find(s => s.startTime === target.startTime);
  log("availability as therapist", targetAsTherapist);
  assert(targetAsTherapist.status === "held_by_other", "non-owner sees held_by_other");

  // 9a. Patient B tries to hold the SAME slot that Patient A already holds → 409 SLOT_HELD.
  const bTriesA = await req(
    "/holds",
    { method: "POST", body: JSON.stringify({ therapistId, startTime: target.startTime, endTime: target.endTime }) },
    patient2Token
  );
  log("Patient B holding Patient A's slot", bTriesA);
  assert(bTriesA.status === 409, "patient B blocked from taking A's held slot");

  // 9b. Patient B holds a DIFFERENT slot → succeeds independently.
  const otherSlot = avail.body.slots[3];
  const bTakesOther = await req(
    "/holds",
    { method: "POST", body: JSON.stringify({ therapistId, startTime: otherSlot.startTime, endTime: otherSlot.endTime }) },
    patient2Token
  );
  log("Patient B taking a different slot", bTakesOther);
  assert(bTakesOther.status === 201, "patient B can hold a different slot");
  // Release B's hold so it doesn't pollute later state.
  await req("/holds/mine", { method: "DELETE" }, patient2Token);

  // 10. release the hold
  const rel = await req("/holds/mine", { method: "DELETE" }, patientToken);
  log("DELETE /holds/mine", rel.body);
  assert(rel.status === 200 && rel.body.released === true, "hold released");

  // 11. GET /holds/mine now null
  const noneNow = await req("/holds/mine", {}, patientToken);
  assert(noneNow.body.hold === null, "no active hold after release");

  // 12. availability again — slot free
  const avail3 = await req(`/availability?therapistId=${therapistId}`, {}, patientToken);
  const targetAfterRelease = avail3.body.slots.find(s => s.startTime === target.startTime);
  assert(targetAfterRelease.status === "available", "slot available again after release");

  // 13. therapists cannot POST /holds
  const forbidden = await req(
    "/holds",
    { method: "POST", body: JSON.stringify({ therapistId, startTime: target.startTime, endTime: target.endTime }) },
    therapistToken
  );
  log("POST /holds as therapist", forbidden);
  assert(forbidden.status === 403, "therapist forbidden from holding");

  console.log("\nALL PHASE 2 CHECKS PASSED ✓");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
