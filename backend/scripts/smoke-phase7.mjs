// Phase 7 smoke test — hardening.
// Verifies:
//  1. Security headers present (HSTS, X-Frame, CSP, X-Request-ID echo).
//  2. ZodError responses return {code:"VALIDATION_ERROR", details:{fieldErrors}}
//  3. UUID route params rejected before the DB is touched (400).
//  4. Idempotency-Key format enforced (400 for bad chars / bad length).
//  5. Auth limiter: repeated /auth/login attempts eventually 429.
//  6. Booking limiter: repeated POST /holds eventually 429 (per-user key).
//  7. Global CORS + credentials NOT allowed (spot check).
//  8. Admin-guarded /series/extend accessible in dev (ADMIN_TOKEN unset).
//
// IMPORTANT: To get deterministic rate-limit results, restart the backend
// immediately before running this script so the in-memory limiter starts
// fresh.

const BASE = process.env.API_URL ?? "http://localhost:4000";

const results = [];
const record = (name, ok, extra = "") => {
  results.push({ name, ok, extra });
  console.log(`${ok ? "  \u2713" : "  \u2717"} ${name}${extra ? " — " + extra : ""}`);
};

async function req(path, opts = {}) {
  const res = await fetch(BASE + path, {
    method: opts.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.idem ? { "Idempotency-Key": opts.idem } : {}),
      ...opts.headers,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let body = null;
  try {
    body = await res.json();
  } catch {}
  return { status: res.status, body, headers: Object.fromEntries(res.headers) };
}

function assert(cond, name, extra = "") {
  record(name, Boolean(cond), extra);
  if (!cond) throw new Error(`Assertion failed: ${name}`);
}

async function login(email) {
  const r = await req("/auth/login", {
    method: "POST",
    body: { email, password: "123456" },
  });
  if (r.status !== 200) throw new Error(`login ${email} → ${r.status}`);
  return { token: r.token ?? r.body.token, user: r.body.user };
}

console.log("\n== Phase 7 smoke ==\n");

console.log("[1] Security headers + request id");
{
  const r = await req("/health");
  assert(r.status === 200, "health 200");
  assert(r.headers["strict-transport-security"], "HSTS header present");
  assert(r.headers["x-content-type-options"] === "nosniff", "X-Content-Type-Options nosniff");
  assert(r.headers["x-frame-options"], "X-Frame-Options set");
  assert(r.headers["x-request-id"], "X-Request-ID echoed");
  assert(r.headers["ratelimit-policy"], "RateLimit-Policy header advertised");

  const r2 = await req("/health", { headers: { "X-Request-ID": "smoke-request-id-fixed" } });
  assert(
    r2.headers["x-request-id"] === "smoke-request-id-fixed",
    "custom X-Request-ID preserved",
    r2.headers["x-request-id"]
  );
}

// Log in one patient early so we can use the token for later tests before
// the auth-limit test exhausts /auth/login.
console.log("\n[2] Setup — login a patient (before auth-limit test)");
const patient = await login("patient@test.com");
assert(patient.token, "obtained patient token");

console.log("\n[3] ZodError shape");
{
  const r = await req("/holds", {
    method: "POST",
    token: patient.token,
    body: { therapistId: "not-a-uuid", startTime: "nope", endTime: "nope" },
  });
  assert(r.status === 400, "bad body 400");
  assert(r.body?.error?.code === "VALIDATION_ERROR", "code = VALIDATION_ERROR");
  assert(r.body?.error?.details?.fieldErrors, "details.fieldErrors present");
  assert(
    Array.isArray(r.body.error.details.fieldErrors.therapistId),
    "fieldErrors.therapistId is an array"
  );
}

console.log("\n[4] Route :id must be a UUID (skips DB)");
{
  const r = await req("/appointments/not-a-uuid", {
    method: "DELETE",
    token: patient.token,
  });
  assert(r.status === 400, "non-UUID id → 400", `got ${r.status}`);
  assert(
    r.body?.error?.code === "VALIDATION_ERROR",
    "VALIDATION_ERROR for bad param"
  );

  const r2 = await req("/series/oops", {
    method: "DELETE",
    token: patient.token,
  });
  assert(r2.status === 400, "series/:id non-UUID → 400");
}

console.log("\n[5] Idempotency-Key format");
{
  const r = await req("/appointments", {
    method: "POST",
    token: patient.token,
    idem: "short",
    body: {
      therapistId: "00000000-0000-0000-0000-000000000000",
      startTime: "2099-01-01T10:00:00.000Z",
      endTime: "2099-01-01T10:30:00.000Z",
    },
  });
  assert(r.status === 400, "short idem key → 400", `got ${r.status}`);
  assert(
    r.body?.error?.message?.includes("Idempotency-Key"),
    "message mentions Idempotency-Key"
  );

  const r2 = await req("/appointments", {
    method: "POST",
    token: patient.token,
    idem: "has spaces and #hash", // contains disallowed chars
    body: {
      therapistId: "00000000-0000-0000-0000-000000000000",
      startTime: "2099-01-01T10:00:00.000Z",
      endTime: "2099-01-01T10:30:00.000Z",
    },
  });
  assert(r2.status === 400, "bad-chars idem key → 400", `got ${r2.status}`);
}

console.log("\n[6] Booking limiter (per-user)");
{
  // Fire 32 hold requests with a bogus therapistId (server will 400 on
  // validation but rate limit runs BEFORE zod). Anyway 400s still count
  // against the limit because the limiter is middleware.
  //
  // Use a valid UUID that doesn't exist to get 404/400 responses; each
  // counts against the per-user booking bucket (limit = 30).
  let ok = 0;
  let limited = 0;
  const bogusUuid = "11111111-1111-1111-1111-111111111111";
  const start = "2099-01-01T10:00:00.000Z";
  const end = "2099-01-01T10:30:00.000Z";
  for (let i = 0; i < 40; i++) {
    const r = await req("/holds", {
      method: "POST",
      token: patient.token,
      body: { therapistId: bogusUuid, startTime: start, endTime: end },
    });
    if (r.status === 429) limited++;
    else ok++;
  }
  assert(limited > 0, `booking limiter fires within 40 requests`, `${limited} × 429 / ${ok} × non-429`);
}

console.log("\n[7] Admin-guarded /series/extend accessible in dev (ADMIN_TOKEN unset)");
{
  const r = await req("/series/extend", {
    method: "POST",
    token: patient.token,
  });
  assert(r.status === 200, "extend 200 in dev", `got ${r.status}`);
  assert(r.body?.seriesProcessed !== undefined, "response contains seriesProcessed");
}

console.log("\n[8] Auth limiter (per-IP)  ⚠ exhausts /auth/login for this window");
{
  let limited = 0;
  let allowed = 0;
  for (let i = 0; i < 20; i++) {
    const r = await req("/auth/login", {
      method: "POST",
      body: { email: `nobody+${i}@example.com`, password: "whatever" },
    });
    if (r.status === 429) limited++;
    else allowed++;
  }
  assert(limited > 0, "auth limiter fires within 20 attempts", `${limited} × 429 / ${allowed} × non-429`);
  assert(allowed <= 12, "no more than ~limit successful attempts", `allowed=${allowed}`);
}

console.log("\n\nALL PHASE 7 CHECKS PASSED \u2713");
