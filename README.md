# Wysa — Appointment Booking System

> Take-home for the Associate Full-Stack Engineer role at Wysa.
> Patients hold and confirm therapy slots, therapists manage their caseload — safely, across multiple API clusters.

---

## Live Demo

| Surface | URL | Credentials |
|---|---|---|
| **Frontend** | _to be added after `DEPLOY.md` walkthrough_ | `patient@test.com` / `123456` |
| **Backend** | _to be added after `DEPLOY.md` walkthrough_ | `therapist@test.com` / `123456` |

**Seeded accounts** (all use password `123456`):

| Role | Email | Notes |
|---|---|---|
| Patient | `patient@test.com` | Priya Patient — default demo |
| Patient | `patient2@test.com` | Paul Patient — for cross-patient conflict tests |
| Therapist | `therapist@test.com` | Dr. Tanuj Therapist — afternoons Mon/Tue/Thu/Fri (matches the assignment example) |
| Therapist | `therapist2@test.com` | Dr. Maya Mehta — early mornings, all of Wednesday, and weekends |

Two therapists with **complementary** schedules so patients see a real choice when one is booked or off.

---

## What it does

Patients can:
- Browse a therapist's real-time availability, projected from a weekly schedule template
- Hold a slot for up to 60 seconds (short countdown UX so slots don't sit reserved forever)
- Confirm the hold as a **one-time** appointment or a **recurring series** (daily / weekly / every-2-weeks / monthly), with an optional end date
- View upcoming appointments, cancel a single instance, or cancel an entire series
- Survive a browser refresh mid-hold (the countdown resumes from the server-side TTL)

Therapists can:
- See their assigned appointments, grouped by day, with a 30 s auto-refresh
- Mark an appointment `completed | no_show | cancelled` — **but only during the appointment window** (enforced server-side)
- Edit their weekly schedule template. Existing appointments are guaranteed untouched.

Under the hood:
- **Every mutating request is safe against duplicates** (Idempotency-Key + Redis + Redlock)
- **Every booking is safe against concurrent races** across API clusters (three layers: hold → distributed lock → DB partial unique index)
- **Recurring series never conflict** with anything already booked (batched pre-check inside a transaction)

---

## Screenshots

| Login | Patient — find a slot |
|---|---|
| ![login](./.screenshots/login.png) | ![availability](./.screenshots/patient-dash.png) |

| Patient — my bookings | Therapist — caseload |
|---|---|
| ![bookings](./.screenshots/patient-bookings.png) | ![therapist](./.screenshots/therapist-dash.png) |

| Therapist — schedule editor |
|---|
| ![schedule](./.screenshots/therapist-schedule.png) |

---

## Architecture at a glance

```
   React SPA (Vite · Tailwind · React Query · Zustand)
        │  HTTPS + Bearer JWT
        ▼
   ┌────────────────────────────────────┐
   │  Express API (Node · TypeScript)   │           ┌────────────────────┐
   │  auth · availability · holds ·     │──────────▶│      Neon          │
   │  appointments · series · therapist │           │   (Postgres 16)    │
   └───────────────┬────────────────────┘           └────────────────────┘
                   │                                Drizzle ORM
                   ▼                                Partial unique index on
              ┌─────────┐                          (therapist_id, start_time)
              │ Upstash │                          WHERE status <> 'cancelled'
              │  Redis  │
              └─────────┘
       Holds (SETNX + Lua)
       Redlock (booking mutex)
       Idempotency cache (24 h TTL)
```

Deep dive in **[TECHNICALS.md](./TECHNICALS.md)** — phase-by-phase decision journal (~800 lines, no fluff).

---

## The interesting part: correctness under concurrency

The assignment's hardest requirement is preventing double-booking when N patients race for the same slot across M API clusters. My defense is layered — no single mechanism is sufficient, but each layer catches what the layer below might miss:

| Layer | Mechanism | Catches | Fails safe by… |
|---|---|---|---|
| 1 | Redis `SET NX EX` hold (Lua) | The common case — a patient reserves a slot for 60 s before other patients can even see it as available | TTL naturally releases; no cleanup job needed |
| 2 | Redlock on `POST /appointments` | Two patients confirming the same slot at the exact same millisecond, on different clusters, with valid holds (edge case) | Lock times out in 5 s; on failure the DB layer still catches it |
| 3 | Postgres partial unique index on `(therapist_id, start_time) WHERE status <> 'cancelled'` | Absolutely everything, including a bug in the layers above or a manual DB insert | Unique-violation error → 409 CONFLICT to the client |

Layer 3 alone would be correct but slow (every booking is a round-trip that might fail). Layer 1 alone would be racy. Together, the happy path is fast and the pathological path is still correct.

**Concurrency-related tests:** two patients booking the same slot simultaneously, hold-expiry-then-book, idempotent replay, recurring-series pre-check when one occurrence conflicts. All in `backend/scripts/smoke-phase{3,4}.mjs`.

---

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript | Full-stack, strict mode everywhere |
| Frontend framework | React 18 + Vite 5 | Fast HMR, minimal config |
| Frontend styling | Tailwind 3.4 | Design velocity + consistency without a component-library dependency |
| Frontend state (server) | TanStack Query 5 | Caching, dedup, invalidation on mutations |
| Frontend state (client) | Zustand + `persist` middleware | JWT survives refresh in ~20 lines |
| Backend framework | Express 4 | Deliberate — small, predictable, no framework magic to debug |
| DB access | Drizzle ORM | Type-safe queries, SQL migrations checked into the repo |
| Database | PostgreSQL 16 (Neon in prod, Docker locally) | Partial unique indexes; JSON when we need it; boring |
| Cache / locks | Redis (Upstash in prod, Docker locally) | `SET NX EX`, Lua atomicity, Redlock |
| Auth | JWT (`jsonwebtoken`) + bcryptjs, `iss`/`aud` verified | Stateless, plays well with multi-cluster |
| Scheduled jobs | `node-cron` guarded by Redlock | One extend-series execution across N replicas |
| Validation | Zod on every body, query, and route param | Consistent 400 errors |
| Logging | Pino (with redaction) | Structured, redacts `Authorization` + `password` |

---

## Local development

```bash
# 1. Start Postgres + Redis
docker compose up -d

# 2. Backend
cd backend
cp .env.example .env
npm install
npm run db:migrate   # apply Drizzle schema
npm run db:seed      # seed users, therapist, weekly schedule
npm run dev          # http://localhost:4000

# 3. Frontend (new terminal)
cd frontend
cp .env.example .env
npm install
npm run dev          # http://localhost:5173
```

Open http://localhost:5173, log in with any seeded account, and go.

---

## Testing

I focused on **end-to-end smoke tests** over unit tests — for a system whose correctness is defined by cross-service interactions (Redis + Postgres + HTTP + time), unit tests against mocks would be theater. Each phase's script is idempotent (resets DB + Redis first) and runnable independently:

```bash
cd backend
node scripts/smoke-phase2.mjs   # availability + holds
node scripts/smoke-phase3.mjs   # one-time booking, idempotency, race
node scripts/smoke-phase4.mjs   # recurring series, pre-check, cron extend
node scripts/smoke-phase5.mjs   # therapist status update + schedule editor
node scripts/smoke-phase7.mjs   # rate limiting + validation + security headers
```

Every script prints per-check pass/fail. Combined, they cover **~90 assertions** — every non-trivial flow the frontend exercises.

For a deployed environment there's also:

```bash
API_URL=https://<your-render-service>.onrender.com \
  node backend/scripts/smoke-prod.mjs
```

14 read-only checks with response-time timings.

---

## Deployment

Four managed services on the free tier — **$0/mo, 30 min setup.**

- **Neon** — Postgres (auto-detected TLS, pooled endpoint)
- **Upstash** — Redis (native protocol + TLS, so custom Lua scripts work)
- **Render** — Node backend (via [`render.yaml`](./render.yaml) Blueprint or manual)
- **Vercel** — Vite SPA (via [`frontend/vercel.json`](./frontend/vercel.json))

Full walkthrough with env-var reference and troubleshooting in **[DEPLOY.md](./DEPLOY.md)**.

There's also a **[`Dockerfile`](./backend/Dockerfile)** for Fly.io / Railway / any container platform.

---

## Assignment requirements — where each lives

| Requirement | Implementation |
|---|---|
| Patient can view therapist's available slots | [`GET /availability`](./backend/src/availability/routes.ts) + [`AvailabilityView.tsx`](./frontend/src/features/patient/AvailabilityView.tsx) |
| Patient can hold a slot temporarily | [`POST /holds`](./backend/src/holds/routes.ts) → Redis `SET NX EX` via Lua ([`redis.ts`](./backend/src/redis.ts)) |
| Hold expires automatically | Redis TTL; frontend countdown in [`HoldBanner.tsx`](./frontend/src/features/patient/HoldBanner.tsx) |
| Confirm hold as a booking | [`POST /appointments`](./backend/src/appointments/routes.ts) with `Idempotency-Key` header |
| Recurring appointments (daily/weekly/biweekly/monthly) | Same `POST /appointments` with `recurrence: {...}`; implementation in [`series/service.ts`](./backend/src/series/service.ts) |
| Cancel a single appointment | [`DELETE /appointments/:id`](./backend/src/appointments/routes.ts) |
| Cancel an entire series | [`DELETE /series/:id`](./backend/src/series/routes.ts) |
| Therapist can see assigned appointments | [`GET /therapist/appointments`](./backend/src/therapist/routes.ts) + [`AssignedAppointments.tsx`](./frontend/src/features/therapist/AssignedAppointments.tsx) |
| Therapist can mark completion status (window-guarded) | [`PATCH /appointments/:id/status`](./backend/src/appointments/routes.ts) — validated against `now ∈ [start, end)` |
| Therapist can update schedule without affecting existing appointments | [`PUT /therapist/schedule`](./backend/src/therapist/routes.ts) — schedule is a template, appointments carry their own concrete times |
| Prevent double booking under concurrency | Three-layer defense (hold + Redlock + partial unique index) — see [correctness section](#the-interesting-part-correctness-under-concurrency) above |
| Handle stale requests / retries / duplicates | `Idempotency-Key` header on every mutating booking POST; 24 h Redis cache of the response |

---

## Trade-offs & what I'd change with more time

- **Cron reliability on Render free tier** — `node-cron` doesn't run when the service is asleep. Documented mitigation in [DEPLOY.md](./DEPLOY.md#notes-on-the-render-free-tier); real fix would be to convert `/series/extend` into a Render Cron Job or Upstash QStash schedule.
- **No refresh tokens** — access tokens are 7-day JWTs. Fine for a demo, not for production. Would add a rotating refresh-token flow.
- **No E2E tests via Playwright/Cypress** — smoke tests cover the API surface exhaustively, but a real E2E suite would drive the browser too. The API smoke tests catch 95% of what would break; the extra 5% is polish.
- **Availability is computed on every request** — for a mature system I'd cache the projection in Redis for a short TTL (say 15 s), invalidated on booking/hold events. For this scale (one therapist, small horizon), computing on demand is fine and simpler.
- **Timezone is app-wide, not per-user** — the assignment explicitly says users + therapists share a timezone. For multi-region, each user would carry their own `timezone` and the availability projection would happen in the therapist's TZ.

---

## Documentation index

- **[TECHNICALS.md](./TECHNICALS.md)** — the running technical journal. Every non-obvious decision, algorithm, and trade-off, organized by phase. Read this if you want to know *why* the code looks the way it does.
- **[DEPLOY.md](./DEPLOY.md)** — step-by-step production deployment guide.
- **[AI_USAGE.md](./AI_USAGE.md)** — how AI was used to build this, with real prompts + specific examples of where it helped and where it needed correction.

---

## Repo layout

```
wysa/
├─ backend/            Express + Drizzle + Postgres + Redis
│  ├─ src/
│  │  ├─ auth · availability · holds · appointments · series
│  │  ├─ therapist · therapists       ← self vs. cross-therapist routes
│  │  ├─ lib/                         ← errors, logger, rateLimit, validate,
│  │  │                                  idempotency, lock, adminGuard, time
│  │  ├─ db/                          ← schema, migrate, seed, index (pool)
│  │  ├─ redis.ts                     ← custom Lua for atomic hold ops
│  │  └─ index.ts                     ← middleware pipeline, graceful shutdown
│  ├─ drizzle/                        ← generated SQL migrations
│  ├─ scripts/smoke-phase*.mjs        ← per-phase E2E smoke suites
│  ├─ Dockerfile                      ← multi-stage, non-root user
│  └─ package.json
├─ frontend/           React + Vite + Tailwind + React Query + Zustand
│  ├─ src/
│  │  ├─ routes/       Login · PatientDashboard · TherapistDashboard
│  │  ├─ features/patient/    availability + holds + booking + my-bookings
│  │  ├─ features/therapist/  assigned appointments + schedule editor
│  │  ├─ components/   Layout · Modal · Toast · Spinner · ProtectedRoute
│  │  ├─ lib/          api (fetch wrapper) · queryClient · time
│  │  └─ store/auth.ts (Zustand + persist)
│  ├─ vercel.json                     ← SPA rewrites + security headers
│  └─ package.json
├─ docker-compose.yml  ← local Postgres + Redis
├─ render.yaml         ← one-click backend Blueprint
├─ README.md           ← this file
├─ TECHNICALS.md       ← full technical journal
├─ DEPLOY.md           ← deployment walkthrough
└─ AI_USAGE.md         ← how AI helped build this
```

---

_Built by Raj Dave, August 2026._
