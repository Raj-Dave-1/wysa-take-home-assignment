// Production smoke test — verifies a deployed backend is healthy end-to-end.
//
// Usage:
//   API_URL=https://wysa-backend.onrender.com \
//   PATIENT_EMAIL=patient@test.com PATIENT_PASSWORD=123456 \
//     node scripts/smoke-prod.mjs
//
// Checks (read-only unless SEED=1):
//   1. GET  /health              → 200
//   2. POST /auth/login          → 200 with JWT
//   3. GET  /therapists          → at least one therapist
//   4. GET  /availability        → 200 with slots array
//   5. GET  /appointments        → 200 (patient's list)
//   6. Security headers present

const BASE = (process.env.API_URL ?? "").replace(/\/$/, "");
if (!BASE) {
  console.error("API_URL env is required (e.g. https://wysa-backend.onrender.com)");
  process.exit(1);
}
const EMAIL = process.env.PATIENT_EMAIL ?? "patient@test.com";
const PASSWORD = process.env.PATIENT_PASSWORD ?? "123456";

let passed = 0;
let failed = 0;
const check = (name, ok, extra = "") => {
  const mark = ok ? "\u2713" : "\u2717";
  console.log(`  ${mark} ${name}${extra ? " — " + extra : ""}`);
  if (ok) passed++;
  else failed++;
};

async function req(path, opts = {}) {
  const started = Date.now();
  const res = await fetch(BASE + path, {
    method: opts.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const took = Date.now() - started;
  let body = null;
  try {
    body = await res.json();
  } catch {}
  return { status: res.status, body, headers: Object.fromEntries(res.headers), took };
}

console.log(`\n== Prod smoke against ${BASE} ==\n`);

console.log("[1] Health");
{
  const r = await req("/health");
  check(`GET /health 200`, r.status === 200, `${r.took}ms`);
  check(`ok=true`, r.body?.ok === true);
  check(`HSTS header`, Boolean(r.headers["strict-transport-security"]));
  check(`X-Request-ID echoed`, Boolean(r.headers["x-request-id"]));
}

console.log("\n[2] Auth");
const login = await req("/auth/login", {
  method: "POST",
  body: { email: EMAIL, password: PASSWORD },
});
check(`POST /auth/login 200`, login.status === 200, `${login.took}ms`);
if (login.status !== 200) {
  console.error("\nLogin failed — cannot continue. Body:", login.body);
  process.exit(1);
}
const token = login.body.token;
check(`response contains JWT`, typeof token === "string" && token.length > 20);
check(`response contains user`, Boolean(login.body.user?.id));

console.log("\n[3] Therapists");
const t = await req("/therapists", { token });
check(`GET /therapists 200`, t.status === 200, `${t.took}ms`);
check(
  `at least one therapist`,
  Array.isArray(t.body?.therapists) && t.body.therapists.length > 0,
  `${t.body?.therapists?.length ?? 0} therapist(s)`
);

console.log("\n[4] Availability");
if (t.body?.therapists?.[0]?.id) {
  const today = new Date().toISOString().slice(0, 10);
  const in7 = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  const a = await req(
    `/availability?therapistId=${t.body.therapists[0].id}&from=${today}&to=${in7}`,
    { token }
  );
  check(`GET /availability 200`, a.status === 200, `${a.took}ms`);
  check(`slots array present`, Array.isArray(a.body?.slots), `${a.body?.slots?.length ?? 0} slot(s)`);
  check(`timezone set`, typeof a.body?.timezone === "string");
} else {
  check(`skipped (no therapists)`, false);
}

console.log("\n[5] Patient's appointments");
{
  const r = await req("/appointments", { token });
  check(`GET /appointments 200`, r.status === 200, `${r.took}ms`);
  check(`appointments array present`, Array.isArray(r.body?.appointments));
}

console.log(`\n---\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
