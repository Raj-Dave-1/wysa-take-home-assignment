// Development-only helper: logs in as a demo user and prints an HTML
// snippet that sets localStorage then redirects to the dashboard.
// Usage: node scripts/dev-screenshot.mjs <patient|patient2|therapist> [pathSuffix]
const email = {
  patient: "patient@test.com",
  patient2: "patient2@test.com",
  therapist: "therapist@test.com",
}[process.argv[2] ?? "patient"];
const pathSuffix = process.argv[3] ?? "";

const res = await fetch("http://localhost:4000/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password: "123456" }),
});
if (!res.ok) {
  console.error("login failed", res.status, await res.text());
  process.exit(1);
}
const { token, user } = await res.json();

const state = { state: { token, user }, version: 0 };
const target = (user.role === "PATIENT" ? "/patient" : "/therapist") + pathSuffix;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>bootstrap</title></head>
<body>
<script>
  localStorage.setItem('wysa.auth', ${JSON.stringify(JSON.stringify(state))});
  location.replace('http://localhost:5173${target}');
</script>
</body></html>`;

process.stdout.write(html);
