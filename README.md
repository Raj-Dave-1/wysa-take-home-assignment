# Wysa - Appointment Booking System

Take-home for the Associate Full-Stack Engineer role at Wysa. Patients hold and confirm therapy slots, therapists manage their caseload - safely, across multiple API clusters.

## Live demo

| | URL |
|---|---|
| **Frontend** | https://wysa-take-home-assignment.vercel.app/ |
| **Backend API** | https://wysa-backend-6las.onrender.com |

> First request after ~15 min of inactivity takes about 30 s while Render's free tier wakes up. Subsequent requests are fast.

## Recording (Optionally)

I’ve recorded a short walkthrough of the application here:  https://www.loom.com/share/00dc0f4ae8494020919e9eae5facc90b

### Demo credentials

All accounts use password `123456`.

| Role | Email | Notes |
|---|---|---|
| Patient | `patient@test.com` | Priya Patient - the main demo account |
| Patient | `patient2@test.com` | Paul Patient - useful for testing cross-patient conflicts |
| Therapist | `therapist@test.com` | Dr. Tanuj - works Mon/Tue/Thu/Fri afternoons (matches the assignment's example schedule) |
| Therapist | `therapist2@test.com` | Dr. Maya - early mornings, Wednesdays, and weekends |

Two therapists with **complementary** schedules so patients see a real choice when one is fully booked or off.

## What the application does

Patients can browse a therapist's real-time availability (projected from a weekly schedule template), hold a slot for up to 60 seconds while they decide, and confirm the hold as either a one-time appointment or a recurring series (daily / weekly / every-2-weeks / monthly). They can cancel individual appointments or an entire series, and the hold countdown even survives a browser refresh (the frontend re-reads the server-side TTL).

Therapists see their assigned appointments grouped by day, can mark an appointment `completed`, `no_show`, or `cancelled` - but only while the appointment window is actually happening, enforced server-side - and can edit their weekly schedule template without touching any existing bookings.

## Tech stack

- **Frontend:** React 18, Vite 5, Tailwind CSS 3, TanStack Query 5, Zustand (with `persist` for JWT), React Router 6, Day.js
- **Backend:** Node 20, Express 4, TypeScript, Drizzle ORM, Zod, Pino, `node-cron`
- **Database:** PostgreSQL 16 (Neon in production, Docker locally)
- **Cache / distributed locks:** Redis 7 (Upstash in production, Docker locally) with `ioredis` + `redlock`
- **Auth:** JWT (`jsonwebtoken`) with `iss` / `aud` verification, `bcryptjs` for passwords
- **Deployment:** Render (backend), Vercel (frontend), Neon (Postgres), Upstash (Redis) - all free tier, $0/mo

## Architecture

```
    React SPA (Vercel)
          │  HTTPS + Bearer JWT
          ▼
    Express API (Render, TypeScript + Drizzle)
          │
    ┌─────┴──────┐
    ▼            ▼
  Postgres     Redis
  (Neon)      (Upstash)
```

The backend is stateless - all state lives in Postgres (persistent: users, appointments, schedules) or Redis (ephemeral: slot holds, idempotency cache, distributed locks). This means it scales horizontally without any coordination beyond what Redis already provides.

Full architectural walk-through in [TECHNICALS.md](./TECHNICALS.md).

## Features

- **Authentication** - JWT-based, two roles (`PATIENT`, `THERAPIST`) with role-based route guards on both the backend and the frontend.
- **Availability projection** - slots are computed dynamically from the therapist's weekly template on every request; nothing is pre-generated.
- **Temporary slot holds** - Redis `SET NX EX` with a Lua script for atomicity, plus a reverse-index (`patient:hold:{id}`) so a patient's active hold can be looked up in O(1) after a page refresh.
- **One-time bookings** - every `POST /appointments` requires an `Idempotency-Key` header. The response is cached in Redis for 24 h, so retries are safe.
- **Recurring appointments** - daily, weekly, every-2-weeks, monthly. Materialized for a 90-day rolling horizon; a nightly cron (guarded by Redlock) extends active series so appointments never "run out."
- **Therapist schedule management** - editing a schedule replaces the template atomically inside a transaction. Existing bookings carry their own concrete start/end times and are never affected.
- **Appointment status updates** - therapists can only mark a status while `now ∈ [start, end)`. Enforced server-side, not just in the UI.
- **Distributed-safe booking** - three layers of defense against double-booking, described below.

## Demo credentials

_(see the table at the top of this file)_

## Live URLs

_(see the table at the top of this file)_

## Assumptions

A few things I decided (or interpreted) about the requirements:

1. **All users and therapists share a single application timezone**, configured via `APP_TIMEZONE` (default `Asia/Kolkata`). The assignment explicitly said this was acceptable. Multi-timezone would need per-user TZ + projection in the therapist's TZ.
2. **A schedule window is one bookable slot.** So a window like `13:30-14:00` on Monday represents one 30-minute slot, not "any 30-minute window inside 13:30-14:00." This matches the assignment's example table.
3. **Schedule edits do not affect existing bookings.** Appointments carry their own concrete `start_time` / `end_time` - the schedule template is only used to project *future* availability. This falls out naturally from the data model (schedules aren't foreign-keyed to appointments) and is one of the assignment's explicit requirements.
4. **Recurring series can have an optional end date.** If not provided, the series is materialized for a 90-day horizon and extended nightly by a cron job. A patient can cancel a single occurrence without affecting the rest of the series, or cancel the whole series in one call.
5. **Holds are 60 seconds by default** (`HOLD_TTL_SECONDS`). Short enough that slots don't sit reserved forever if a patient walks away; long enough for someone to fill in a modal.
6. **Only one active hold per patient at any time.** Attempting to hold a second slot while one is active fails with 409 - enforced with the reverse-index above.

## Challenges

The two hardest problems in this build were both about **being correct in the presence of concurrency**.

### 1. Preventing double-booking across replicas

If two patients race to book the same slot at the same millisecond, from different browsers, and the backend is running on multiple replicas, only one booking must succeed. My defense is three layers deep:

- **Layer 1 - Redis hold** (Lua `SET NX EX`). The common case: whoever "held" the slot first is the only one who can confirm. TTL means holds self-clean.
- **Layer 2 - Redlock on the booking endpoint.** Even if two patients somehow both have valid holds on the same slot (should be impossible, but defense in depth), the Redlock across replicas ensures only one INSERT actually runs.
- **Layer 3 - Postgres partial unique index** on `(therapist_id, start_time) WHERE status <> 'cancelled'`. The final safety net - even if Layers 1 and 2 both had bugs, or someone hand-inserted a row, the database itself would reject the duplicate.

Layer 3 alone would be correct but slow. Layer 1 alone would be racy. Together, the happy path is fast (one Redis roundtrip decides everything) and the pathological path is still correct.

### 2. Idempotency

A patient hits "Confirm booking," their laptop hiccups, the request retries. Without idempotency, they end up with two identical appointments and their card charged twice.

Every mutating booking POST requires an `Idempotency-Key` header. The backend caches the response in Redis keyed by `idem:{patientId}:{key}` for 24 h. Concurrent requests with the same key are serialized via Redlock - the second one blocks until the first finishes, then returns the same cached response. Retries are free; duplicates are impossible.

### 3. Recurring appointment enumeration without date-arithmetic drift

Naïvely, "weekly for 90 days" is `for i in 0..N: date + i*7 days`. That breaks around DST and gives weird results for `monthly`. The [`enumerateOccurrences`](./backend/src/series/frequency.ts) function calculates each occurrence *relative to the original anchor date* - never chains additions - so DST shifts and variable month lengths just work.

Once occurrences are enumerated, they're filtered against the therapist's weekly schedule (a `daily` series on a therapist who's off Wednesdays skips those), pre-checked against every existing booking and hold in a batched query, and only then inserted transactionally.

## Local development

```bash
# 1. Start Postgres + Redis locally
docker compose up -d

# 2. Backend
cd backend
cp .env.example .env
npm install
npm run db:migrate   # apply Drizzle schema
npm run db:seed      # seed patients, therapists, weekly schedules
npm run dev          # http://localhost:4000

# 3. Frontend (new terminal)
cd frontend
cp .env.example .env
npm install
npm run dev          # http://localhost:5173
```

Open http://localhost:5173 and log in with any seeded account.

Full local-dev walkthrough (with troubleshooting) is in [TECHNICALS.md](./TECHNICALS.md#local-development).

## Testing

I focused on end-to-end smoke tests over unit tests. For a system whose correctness is defined by cross-service interactions (Redis + Postgres + HTTP + time), unit tests against mocks would be theater. Each phase has an idempotent smoke script that resets state and runs a scenario:

```bash
cd backend
node scripts/smoke-phase2.mjs   # availability + holds
node scripts/smoke-phase3.mjs   # one-time booking, idempotency, race
node scripts/smoke-phase4.mjs   # recurring series, pre-check, cron extend
node scripts/smoke-phase5.mjs   # therapist status update + schedule editor
node scripts/smoke-phase7.mjs   # rate limiting + validation + security headers
```

Combined, they cover about 90 assertions across every non-trivial flow the frontend exercises.

For the live backend:

```bash
API_URL=https://wysa-backend-6las.onrender.com \
  node backend/scripts/smoke-prod.mjs
```

## Deployment

Four managed services on the free tier. Full walkthrough with env-var reference and troubleshooting in [DEPLOY.md](./DEPLOY.md). Configuration lives in [`render.yaml`](./render.yaml) for the backend and [`frontend/vercel.json`](./frontend/vercel.json) for the frontend. There's also a [`Dockerfile`](./backend/Dockerfile) for Fly.io / Railway / any container platform.

## Documentation

- **[TECHNICALS.md](./TECHNICALS.md)** - the running technical journal. Every non-obvious decision, algorithm, and trade-off, organized by phase. Read this if you want to know *why* the code looks the way it does.
- **[DEPLOY.md](./DEPLOY.md)** - step-by-step production deployment guide.
- **[AI_USAGE.md](./AI_USAGE.md)** - how AI was used, with real prompts and specific examples of where it helped and where it needed correction.

## Trade-offs I'd revisit with more time

- Render free tier sleeps after 15 min idle. The nightly `node-cron` for series extension won't fire while sleeping; documented mitigation in [DEPLOY.md](./DEPLOY.md).
- Access tokens are 7-day JWTs with no refresh. Fine for a demo, would add a rotating refresh flow in production.
- Availability is computed on every request. For heavier scale I'd cache the projection in Redis with a short TTL, invalidated on booking/hold events.
- No Playwright/Cypress E2E - the API smoke tests catch 95% of what would break, but a browser-level suite would catch the remaining 5%.

## Repo layout

```
wysa/
├─ backend/            Express + Drizzle + Postgres + Redis
│  ├─ src/
│  │  ├─ auth · availability · holds · appointments · series
│  │  ├─ therapist · therapists       ← self vs. cross-therapist routes
│  │  ├─ lib/                         ← errors, logger, rateLimit, idempotency,
│  │  │                                  lock, adminGuard, validate, time
│  │  ├─ db/                          ← schema, migrate, seed, pool
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
