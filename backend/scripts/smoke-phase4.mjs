// Phase 4 smoke test — recurring series booking, cancel semantics, and cron extension.
// Run: node scripts/smoke-phase4.mjs

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

  await req("/holds/mine", { method: "DELETE" }, patientToken);
  await req("/holds/mine", { method: "DELETE" }, patient2Token);

  const therapists = (await req("/therapists", {}, patientToken)).body.therapists;
  const therapistId = therapists[0].id;

  // Get an available slot to serve as our anchor. Pick the FIRST one (soonest).
  const avail = await req(
    `/availability?therapistId=${therapistId}&from=${new Date().toISOString().slice(0, 10)}&to=${new Date(Date.now() + 14 * 86400 * 1000).toISOString().slice(0, 10)}`,
    {},
    patientToken
  );
  const openSlots = avail.body.slots.filter((s) => s.status === "available");
  assert(openSlots.length >= 4, "at least 4 available slots for series testing");

  const anchor = openSlots[0];

  // --- SCENARIO 0: set up a ONE-TIME appointment 7 days after anchor,
  //     so we can prove that a WEEKLY series booked from `anchor` is rejected
  //     because one of its occurrences would collide with that appointment. ---
  const anchorMs = new Date(anchor.startTime).getTime();
  const oneWeekLater = openSlots.find(
    (s) => new Date(s.startTime).getTime() - anchorMs === 7 * 86400 * 1000
  );
  assert(oneWeekLater, "found a slot exactly 7 days after anchor");

  await req(
    "/holds",
    {
      method: "POST",
      body: JSON.stringify({
        therapistId,
        startTime: oneWeekLater.startTime,
        endTime: oneWeekLater.endTime,
      }),
    },
    patient2Token
  );
  const p2OneTime = await req(
    "/appointments",
    {
      method: "POST",
      body: JSON.stringify({
        therapistId,
        startTime: oneWeekLater.startTime,
        endTime: oneWeekLater.endTime,
      }),
    },
    patient2Token,
    { "Idempotency-Key": uuid() }
  );
  assert(p2OneTime.status === 201, "Patient B booked one-time 7d after anchor");

  // Patient A holds the anchor and tries WEEKLY — the 2nd occurrence (anchor + 7d)
  // conflicts with B's one-time. Pre-check must catch it and return 409.
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
  const weeklyConflict = await req(
    "/appointments",
    {
      method: "POST",
      body: JSON.stringify({
        therapistId,
        startTime: anchor.startTime,
        endTime: anchor.endTime,
        recurrence: { frequency: "weekly" },
      }),
    },
    patientToken,
    { "Idempotency-Key": uuid() }
  );
  log("weekly series that would collide with B's one-time", weeklyConflict);
  assert(weeklyConflict.status === 409, "series conflict → 409");
  assert(
    Array.isArray(weeklyConflict.body.error?.details?.conflicts) &&
      weeklyConflict.body.error.details.conflicts.includes(oneWeekLater.startTime),
    "response lists the offending occurrence"
  );

  // Cancel B's one-time to clear the way for the happy-path weekly series below.
  await req(
    `/appointments/${p2OneTime.body.appointment.id}`,
    { method: "DELETE" },
    patient2Token
  );

  // --- SCENARIO 1: weekly series booking (happy path) ---
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

  const weeklyKey = uuid();
  const weeklyBook = await req(
    "/appointments",
    {
      method: "POST",
      body: JSON.stringify({
        therapistId,
        startTime: anchor.startTime,
        endTime: anchor.endTime,
        recurrence: { frequency: "weekly" },
      }),
    },
    patientToken,
    { "Idempotency-Key": weeklyKey }
  );
  log("POST /appointments (weekly series)", {
    status: weeklyBook.status,
    seriesId: weeklyBook.body.series?.id,
    apptCount: weeklyBook.body.appointments?.length,
    skipped: weeklyBook.body.skipped,
    horizonEnd: weeklyBook.body.horizonEnd,
    firstThreeStarts: weeklyBook.body.appointments?.slice(0, 3).map((a) => a.startTime),
  });
  assert(weeklyBook.status === 201, "weekly series created");
  const weeklySeriesId = weeklyBook.body.series.id;
  const weeklyAppts = weeklyBook.body.appointments;
  assert(weeklyAppts.length >= 10, `weekly should produce >=10 occurrences over 90d (got ${weeklyAppts.length})`);
  assert(
    weeklyAppts.every((a) => a.seriesId === weeklySeriesId),
    "all appointments share the same series id"
  );
  assert(weeklyAppts[0].startTime === anchor.startTime, "first appointment is the anchor");

  // Verify weekly cadence: exactly 7 days between consecutive occurrences
  for (let i = 1; i < Math.min(5, weeklyAppts.length); i++) {
    const prev = new Date(weeklyAppts[i - 1].startTime).getTime();
    const cur = new Date(weeklyAppts[i].startTime).getTime();
    const gapDays = (cur - prev) / (86400 * 1000);
    assert(gapDays === 7, `week ${i} → ${i + 1} gap is 7d (got ${gapDays})`);
  }

  // --- SCENARIO 2: idempotency replay of series booking ---
  const replay = await req(
    "/appointments",
    {
      method: "POST",
      body: JSON.stringify({
        therapistId,
        startTime: anchor.startTime,
        endTime: anchor.endTime,
        recurrence: { frequency: "weekly" },
      }),
    },
    patientToken,
    { "Idempotency-Key": weeklyKey }
  );
  log("Series replay same key", {
    status: replay.status,
    replay: replay.headers["idempotent-replay"],
    seriesId: replay.body.series?.id,
  });
  assert(replay.status === 201, "replay returns 201");
  assert(replay.body.series.id === weeklySeriesId, "replay returns SAME series id");
  assert(replay.headers["idempotent-replay"] === "true", "Idempotent-Replay header set");

  // --- SCENARIO 4: cancel SINGLE instance leaves series active ---
  const singleCancel = await req(
    `/appointments/${weeklyAppts[1].id}`,
    { method: "DELETE" },
    patientToken
  );
  log("cancel single instance", singleCancel);
  assert(singleCancel.status === 200, "single instance cancel 200");
  assert(singleCancel.body.appointment.status === "cancelled", "instance now cancelled");
  assert(singleCancel.body.appointment.seriesId === weeklySeriesId, "seriesId unchanged");

  // Series should still be active with the remaining N-1 appointments visible
  const seriesAfter = await req("/series", {}, patientToken);
  const targetSeries = seriesAfter.body.series.find((s) => s.id === weeklySeriesId);
  assert(targetSeries?.active === true, "series still active after instance cancel");

  const apptList = (await req("/appointments", {}, patientToken)).body.appointments;
  const seriesAppts = apptList.filter((a) => a.seriesId === weeklySeriesId);
  const cancelledInSeries = seriesAppts.filter((a) => a.status === "cancelled");
  const scheduledInSeries = seriesAppts.filter((a) => a.status === "scheduled");
  log("series state after single cancel", {
    total: seriesAppts.length,
    cancelled: cancelledInSeries.length,
    scheduled: scheduledInSeries.length,
  });
  assert(cancelledInSeries.length === 1, "exactly 1 cancelled in series");
  assert(scheduledInSeries.length === seriesAppts.length - 1, "rest still scheduled");

  // --- SCENARIO 5: cancel ENTIRE series ---
  const seriesCancel = await req(
    `/series/${weeklySeriesId}`,
    { method: "DELETE" },
    patientToken
  );
  log("cancel series", seriesCancel);
  assert(seriesCancel.status === 200, "series cancel 200");
  assert(seriesCancel.body.cancelledCount >= 1, "at least one appointment cancelled by series cancel");

  const apptList2 = (await req("/appointments", {}, patientToken)).body.appointments;
  const seriesApptsAfter = apptList2.filter((a) => a.seriesId === weeklySeriesId);
  const stillScheduled = seriesApptsAfter.filter((a) => a.status === "scheduled");
  assert(stillScheduled.length === 0, "no scheduled appointments remain in cancelled series");

  const seriesFinal = (await req("/series", {}, patientToken)).body.series.find(
    (s) => s.id === weeklySeriesId
  );
  assert(seriesFinal.active === false, "series marked inactive");

  // Cancelling someone else's series → 403
  await req(
    "/holds",
    {
      method: "POST",
      body: JSON.stringify({
        therapistId,
        startTime: openSlots[3].startTime,
        endTime: openSlots[3].endTime,
      }),
    },
    patient2Token
  );
  const p2Series = await req(
    "/appointments",
    {
      method: "POST",
      body: JSON.stringify({
        therapistId,
        startTime: openSlots[3].startTime,
        endTime: openSlots[3].endTime,
        recurrence: { frequency: "weekly" },
      }),
    },
    patient2Token,
    { "Idempotency-Key": uuid() }
  );
  const p2SeriesId = p2Series.body.series.id;
  const wrongOwner = await req(`/series/${p2SeriesId}`, { method: "DELETE" }, patientToken);
  log("cancel someone else's series", wrongOwner);
  assert(wrongOwner.status === 403, "cannot cancel someone else's series");

  // --- SCENARIO 6: DAILY skips off-schedule days ---
  // A DAILY series anchored on a Monday morning should have far fewer than 90
  // appointments — many days won't match the schedule (Wed/Sat/Sun are empty).
  await req("/holds/mine", { method: "DELETE" }, patient2Token);
  await req("/holds/mine", { method: "DELETE" }, patientToken);
  const dailyAnchor = openSlots[2]; // some slot in the near future
  await req(
    "/holds",
    {
      method: "POST",
      body: JSON.stringify({
        therapistId,
        startTime: dailyAnchor.startTime,
        endTime: dailyAnchor.endTime,
      }),
    },
    patientToken
  );
  const dailyBook = await req(
    "/appointments",
    {
      method: "POST",
      body: JSON.stringify({
        therapistId,
        startTime: dailyAnchor.startTime,
        endTime: dailyAnchor.endTime,
        recurrence: { frequency: "daily" },
      }),
    },
    patientToken,
    { "Idempotency-Key": uuid() }
  );
  log("daily series", {
    status: dailyBook.status,
    total: dailyBook.body.appointments?.length,
    skipped: dailyBook.body.skipped,
  });
  assert(dailyBook.status === 201, "daily series created");
  assert(dailyBook.body.skipped > 0, `daily should skip off-schedule days (skipped=${dailyBook.body.skipped})`);
  assert(dailyBook.body.appointments.length > 0, "daily still produces at least one occurrence");
  // Cadence check disabled for daily since we skip.

  // --- SCENARIO 7: extend job is idempotent ---
  const extend1 = await req("/series/extend", { method: "POST" }, patientToken);
  const extend2 = await req("/series/extend", { method: "POST" }, patientToken);
  log("extend runs", { first: extend1.body, second: extend2.body });
  assert(extend1.status === 200 && extend2.status === 200, "extend endpoint 200");
  assert(extend2.body.appointmentsCreated === 0, "second extend creates no new appointments (idempotent)");

  console.log("\nALL PHASE 4 CHECKS PASSED ✓");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
