# Technical Journal

Living document. Every phase appends here - decisions, algorithms, trade-offs, and the reasoning behind each choice. The intent is that reading this alone gives a full picture of *why* the code looks the way it does, without having to read the code.

---

## Table of Contents

- [System Overview](#system-overview)
- [Global Design Decisions](#global-design-decisions)
- [Local Development](#local-development)
- [Troubleshooting](#troubleshooting)
- [Phase 1 - Foundation](#phase-1--foundation)
- [Phase 2 - Availability & Holds](#phase-2--availability--holds)
- [Phase 3 - Booking (one-time)](#phase-3--booking-one-time)
- [Phase 4 - Recurring Series](#phase-4--recurring-series)
- [Phase 5 - Therapist Flows](#phase-5--therapist-flows)
- [Phase 6 - Frontend](#phase-6--frontend)
- [Phase 7 - Hardening](#phase-7--hardening)
- [Phase 8 - Deployment](#phase-8--deployment)

---

## System Overview

```
   React SPA (Vite)
        │  HTTPS / Bearer JWT
        ▼
   ┌────────────────────────────────────┐
   │ Express API (deployed 3 clusters)  │
   │  auth · availability · holds ·     │
   │  appointments · schedules · series │
   └──────┬──────────────────────┬──────┘
          │                      │
          ▼                      ▼
    ┌──────────┐            ┌──────────┐
    │ Postgres │            │  Redis   │
    │ (Neon)   │            │(Upstash) │
    └──────────┘            └──────────┘
      source of truth       fast path:
      unique constraints     holds, locks,
      transactional writes   idempotency
```

- **Postgres = source of truth.** All permanent state lives here; unique partial index is the last line of defense against double-booking.
- **Redis = fast, ephemeral coordination.** Temporary holds, distributed locks (Redlock), and idempotency response cache. Never store durable state here.
- **3 API clusters.** Every mutation must be safe under simultaneous execution on different nodes. The design assumes any request can arrive at any cluster, and uses Redis + DB atomicity - never in-process memory - for coordination.

---

## Global Design Decisions

| Decision | Choice | Why |
|---|---|---|
| Language / runtime | Node 20 + TypeScript (ESM) | Assignment requires Node; TS for safety across many small modules |
| Framework | Express | Ubiquitous, unopinionated, fits the 3-cluster stateless shape |
| ORM | Drizzle | Lightweight, first-class TS types, painless raw SQL escape hatch when needed, good `INSERT … ON CONFLICT` support |
| Database | Postgres 16 (local Docker, Neon in prod) | Partial unique indexes, `timestamptz`, transactional guarantees needed for booking |
| Cache/locks | Redis 7 (local Docker, Upstash in prod) | `SET NX EX`, Lua scripting, Redlock |
| Time zone | Single `APP_TIMEZONE` env (default `Asia/Kolkata`) | Assignment states users + therapists share a TZ; kept configurable so it isn't hardcoded |
| Validation | zod at every boundary | Env schema, request bodies, request queries |
| Auth | JWT (HS256, 7d expiry) via bcryptjs | Stateless - the 3-cluster architecture must not need session affinity |
| Idempotency (Phase 3) | `Idempotency-Key` header + Redis cache | Only way to make POST safe under retries + duplicate cluster delivery |
| Concurrency (Phase 3) | Hold → Redlock → DB unique index | Three layers of defense; each catches a different failure mode |

---

## Local Development

The full stack runs on your laptop with three moving parts: **Docker (Postgres + Redis)**, **backend (Node)**, **frontend (Vite)**. Everything auto-reloads on file change.

### Prerequisites

| Tool | Min version | Check with | Install |
|---|---|---|---|
| Node.js | 20.x | `node -v` | [nodejs.org](https://nodejs.org) or `nvm install 20` |
| npm | 10.x | `npm -v` | ships with Node |
| Docker Desktop | any recent | `docker --version` | [docker.com](https://docs.docker.com/desktop/) |
| Docker Compose | v2 | `docker compose version` | ships with Docker Desktop |
| Git | any | `git --version` | pre-installed on macOS / most Linux |

### Ports used

| Port | Service | Configurable via |
|---|---|---|
| **5433** | Postgres (Docker → host) | `docker-compose.yml` (mapped from container's 5432 to avoid clashing with any local Postgres) |
| **6379** | Redis (Docker → host) | `docker-compose.yml` |
| **4000** | Backend API | `PORT` env in `backend/.env` |
| **5173** | Frontend dev server | `frontend/vite.config.ts` (`strictPort: true` - deliberate fail-fast) |

If any of these are already in use on your machine, either free them or override in the config files.

### First-time setup (three terminals)

```bash
# --- 1. Clone and enter the repo ---
git clone <repo-url> wysa && cd wysa

# --- 2. Bring up Postgres + Redis in Docker ---
docker compose up -d
# → container names: wysa_postgres, wysa_redis
# → healthcheck: `docker compose ps` should show both as "healthy" within ~10 s
```

**Terminal A - backend:**

```bash
cd backend
cp .env.example .env       # defaults work as-is for local dev
npm install                # installs express, drizzle, ioredis, redlock, zod, etc.
npm run db:migrate         # applies drizzle/0000_init.sql (creates 6 tables + enums + partial unique index)
npm run db:seed            # creates 2 patients + 2 therapists with distinct weekly schedules
npm run dev                # tsx watch → http://localhost:4000
```

**Terminal B - frontend:**

```bash
cd frontend
cp .env.example .env       # VITE_API_URL=http://localhost:4000
npm install                # React, Vite, Tailwind, React Query, Zustand
npm run dev                # → http://localhost:5173
```

Open http://localhost:5173 → click **Patient** on the login card → sign in. You should land on the availability grid with slots for the seeded therapist.

### Verify the stack end-to-end

```bash
# Health check (no auth required)
curl http://localhost:4000/health
# → {"ok":true,"ts":"2026-08-06T..."}

# Point the prod smoke script at localhost - should print 14 checks passing
API_URL=http://localhost:4000 node backend/scripts/smoke-prod.mjs
```

### Everyday commands (backend)

| Task | Command |
|---|---|
| Start dev server (auto-reload) | `npm run dev` |
| Typecheck without running | `npm run typecheck` |
| Production build | `npm run build` → outputs `dist/` |
| Boot the compiled build | `npm start` |
| Generate a new migration from schema changes | `npm run db:generate` |
| Apply pending migrations | `npm run db:migrate` |
| Re-seed (idempotent - safe to run any time) | `npm run db:seed` |
| Open Drizzle Studio (visual DB browser) | `npm run db:studio` → https://local.drizzle.studio |

### Everyday commands (frontend)

| Task | Command |
|---|---|
| Start dev server | `npm run dev` |
| Typecheck | `npm run typecheck` |
| Production build | `npm run build` → outputs `dist/` |
| Preview the built bundle | `npm run preview` |

### Running the smoke tests

Each phase has a self-contained end-to-end script under `backend/scripts/`. They're runnable in any order but they **reset appointment/hold state at the start** so they don't interfere with each other.

```bash
cd backend
node scripts/smoke-phase2.mjs   # availability + holds (~15 assertions)
node scripts/smoke-phase3.mjs   # one-time booking + idempotency + race (~20 assertions)
node scripts/smoke-phase4.mjs   # recurring series + conflict pre-check + cron (~18 assertions)
node scripts/smoke-phase5.mjs   # therapist status update + schedule editor (~22 assertions)
node scripts/smoke-phase7.mjs   # rate limits + validation + security headers (~22 assertions)
```

Each script prints per-check `✓ / ✗` and exits non-zero on any failure. If you're actively developing, `smoke-phase3.mjs` is the fastest regression check for the concurrency layer.

### Inspecting the running system

**Peek at Postgres:**

```bash
docker exec -it wysa_postgres psql -U wysa -d wysa
# Then, inside psql:
\dt                                            -- list tables
SELECT id, email, role FROM users;
SELECT COUNT(*) FROM appointments;
SELECT * FROM schedules ORDER BY day_of_week;
\q
```

**Peek at Redis:**

```bash
docker exec -it wysa_redis redis-cli
> KEYS *                       # list all keys (fine for dev - never do this in prod)
> KEYS hold:*                  # active slot holds
> KEYS patient:hold:*          # reverse index (one per patient)
> KEYS idem:*                  # cached idempotent responses
> TTL hold:eb46...:2026-08-...T...  # seconds remaining on a specific hold
> QUIT
```

**Watch backend logs live:**

The dev server emits structured JSON via pino. Pretty-print in another terminal:

```bash
tail -f /path/to/nothing   # OR just look at your `npm run dev` terminal
# For prettier output, pipe through pino-pretty:
npm run dev 2>&1 | npx pino-pretty
```

### Resetting to a known-clean state

If your local DB gets weird (partial state from a crashed test, orphaned holds, etc.):

```bash
# Wipe transactional data but keep users + therapist + schedule
docker exec wysa_postgres psql -U wysa -d wysa \
  -c "TRUNCATE appointments, recurring_series RESTART IDENTITY CASCADE;"

# Wipe all Redis keys (holds, idempotency cache, distributed locks)
docker exec wysa_redis redis-cli FLUSHDB

# Or nuclear option - wipe everything including users, then reseed
docker compose down -v         # -v also removes the postgres volume
docker compose up -d
cd backend && npm run db:migrate && npm run db:seed
```

---

## Troubleshooting

Every problem I actually hit while building this, with the fix. Grouped by where you're likely to see the symptom.

### Setup / Docker

**Symptom: `docker compose up -d` fails with "port is already allocated"**
Something on your host is already using 5433, 6379, or one of the mapped ports.
```bash
# Find the culprit
lsof -i :5433
lsof -i :6379
# Kill it, or edit docker-compose.yml to map to a different host port
# (e.g. change "5433:5432" to "5434:5432" and update DATABASE_URL to match)
```

**Symptom: `Cannot connect to the Docker daemon`**
Docker Desktop isn't running. Open the app; wait for the whale icon in your menu bar to stop animating.

**Symptom: local Postgres was running on 5432**
This is why the compose file deliberately maps Docker Postgres to **5433** - to avoid clashing. `DATABASE_URL` in `backend/.env.example` already reflects `:5433`. If you have a local Postgres and it's causing confusion, stop it: `brew services stop postgresql` (macOS) or `sudo systemctl stop postgresql` (Linux).

**Symptom: `wysa_postgres` container flapping / unhealthy**
```bash
docker compose logs postgres    # look for "database system was not properly shut down"
docker compose down -v          # remove the volume and start fresh
docker compose up -d
```

### `npm install`

**Symptom: `EACCES` / `EPERM` on macOS**
You have `sudo`-installed Node, or `~/.npm` has weird permissions.
```bash
# Fix ownership one time
sudo chown -R $(whoami) ~/.npm ~/.node
# Recommended long-term: use nvm so Node lives under $HOME
```

**Symptom: `Cannot find module 'drizzle-orm/node-postgres/migrator'`**
`node_modules` is stale or partial. `rm -rf node_modules package-lock.json && npm install`.

### Backend dev server

**Symptom: `EADDRINUSE :::4000`**
Something else is on port 4000 - often a previous `npm run dev` that didn't cleanly exit.
```bash
lsof -i :4000
kill -9 <PID>
```

**Symptom: `Redis error: ECONNREFUSED 127.0.0.1:6379`**
The Redis container isn't running. `docker compose ps` should show `wysa_redis` as healthy. If not: `docker compose up -d redis`.

**Symptom: backend boots but every request logs `pg: connection refused`**
Postgres container isn't up or `DATABASE_URL` in `.env` points to the wrong host/port. Verify:
```bash
docker compose ps                                        # both containers healthy?
psql "$(grep DATABASE_URL backend/.env | cut -d= -f2)"   # does the URL work?
```

**Symptom: `Migration failed: relation "users" already exists`**
Your DB has partial state from a previous run. Two options:
1. Just re-seed - the seed script uses `ON CONFLICT DO UPDATE` and is safe to re-run.
2. Full reset - see the "Resetting to a known-clean state" section above.

**Symptom: `tsx: EPERM` or "Operation not permitted" during `db:migrate`**
Rare macOS sandbox issue where `tsx` tries to create an IPC pipe in a restricted temp dir. Workaround: run outside restrictive shells (e.g. plain iTerm/Terminal, not a sandboxed IDE terminal).

### Frontend

**Symptom: Vite says `Port 5173 is already in use`**
`vite.config.ts` uses `strictPort: true` deliberately (so the frontend never silently moves to a different port). Free 5173:
```bash
lsof -i :5173
kill -9 <PID>
```

**Symptom: Login works, but the app immediately bounces back to the login page**
JWT verification is failing - usually because you restarted the backend with a new `JWT_SECRET` and your browser has an old token in `localStorage`.
```javascript
// In DevTools console:
localStorage.clear();
location.reload();
```

**Symptom: "No open slots" even though the therapist has a schedule**
This was the actual Phase 6b bug - the availability API expects `YYYY-MM-DD` date strings, not full ISO timestamps. If you see it, verify:
1. Open DevTools → Network → look at the `/availability` request → it should return 200 with a `slots` array. If it's 400, the query params are the wrong format.
2. Verify the therapist actually has schedule rows for the requested day-of-week: `docker exec wysa_postgres psql -U wysa -d wysa -c "SELECT day_of_week, start_time, end_time FROM schedules ORDER BY day_of_week, start_time;"`

**Symptom: CORS errors in the browser console**
`CORS_ORIGIN` in `backend/.env` doesn't include the frontend's exact origin. Locally it should be `http://localhost:5173`. Restart the backend after editing.

**Symptom: Hold banner countdown is negative / stuck at 0**
Server-side TTL has expired but the client didn't refetch. It should self-heal within 1 s (the `useEffect` invalidates the `myHold` query when `remaining === 0`). If not, hard-refresh the page.

### Smoke tests

**Symptom: `smoke-phase7.mjs` - auth limiter test fails with `allowed=20`**
The in-memory rate-limit counter carries state across test runs while the backend is up. Restart the backend (`Ctrl+C`, `npm run dev`) so the limiter starts fresh, then re-run the script.

**Symptom: `smoke-phase3.mjs` - booking test returns `410 GONE`**
A leftover Redis hold from a previous run is blocking the test. `docker exec wysa_redis redis-cli FLUSHDB` and re-run.

**Symptom: `smoke-phase4.mjs` - expected 409 SERIES_CONFLICT, got 410`**
Same root cause as above - a prior test left Patient B holding a slot that the new scenario expects to be free. `FLUSHDB` + `TRUNCATE appointments, recurring_series` and re-run. (This exact scenario is what the fix in the Phase 4 test story is about - see [AI_USAGE.md](./AI_USAGE.md#4-phase-4-smoke-test-scenario-was-self-blocking).)

**Symptom: smoke script hangs**
The backend probably crashed. Look at the `npm run dev` terminal for an unhandled error. If Redis or Postgres died, the request will hang until timeout.

### Concurrency edge cases

**Symptom: two browsers, same account, both click the same slot - both see "your hold"**
Expected - the second click is idempotent (they already had a hold). The `acquireHold` Lua script returns `-1` "you already have a hold" and the frontend treats that as a no-op.

**Symptom: two browsers, **different** accounts, both click the same slot - one gets 200, the other gets 409**
Correct behavior. First wins, second is told "slot is held by someone else." The losing side should refresh availability to see the updated state.

**Symptom: patient booked something but "My bookings" is empty**
React Query caching. The booking mutation invalidates the appointments query, but if you navigated away before it settled, you might see stale data for a few seconds. Pull-to-refresh (or wait 15 s for the `staleTime` to expire).

### General debugging tactics

- **Every response has an `X-Request-ID` header.** If a client hits a bug, grab that header value and grep the backend logs - pino always includes it as `reqId`.
- **Log level:** `LOG_LEVEL=debug npm run dev` for more verbose output.
- **Structured logs:** every log line is JSON. Pipe through `jq` or `pino-pretty` to make them human-readable.
- **Drizzle Studio:** `npm run db:studio` opens a visual browser at https://local.drizzle.studio - good for eyeballing the state after a bug.
- **When in doubt, reset:** the seed is idempotent and the smoke tests are the fastest way to prove the system is fundamentally healthy after a reset.

For deployment-specific troubleshooting (Neon, Upstash, Render, Vercel), see [DEPLOY.md → Troubleshooting](./DEPLOY.md#troubleshooting).

---

## Phase 1 - Foundation

### Goals
1. Repo scaffolding for a monorepo (backend + frontend, deployed independently).
2. Local dev infra via Docker.
3. Full DB schema up front - including tables for Phases 3+4 - so we only migrate once.
4. Seeded users + therapist + assignment's exact 15-row weekly schedule.
5. JWT auth wired to a working `/auth/login` + `authenticate` / `authorize(role)` middleware.

### DB Schema

Seven objects - enums, five tables, one partial unique index. Full definitions in [`backend/src/db/schema.ts`](./backend/src/db/schema.ts).

- `user_role` enum: `PATIENT | THERAPIST`
- `appointment_status` enum: `scheduled | completed | no_show | cancelled`
- `recurrence_frequency` enum: `daily | weekly | biweekly | monthly`
- `users(id, email, password_hash, role, name, created_at)`
- `patients(id, user_id UNIQUE, display_name, created_at)`
- `therapists(id, user_id UNIQUE, display_name, created_at)`
- `schedules(id, therapist_id, day_of_week 0..6, start_time TIME, end_time TIME, created_at)`
  - Slot start/end stored as **time-of-day**, not full datetimes. This is what makes "update schedule doesn't affect existing bookings" trivially correct - the schedule is a *template* consulted at query time, never joined to appointments.
- `recurring_series(id, patient_id, therapist_id, frequency, anchor_start TIMESTAMPTZ, anchor_end TIMESTAMPTZ, end_date TIMESTAMPTZ NULLABLE, materialized_through TIMESTAMPTZ, active, created_at)`
  - `anchor_*` captures the first occurrence in absolute UTC. Every future occurrence is a *pure function* of the anchor + frequency, so we don't have to keep re-deriving from the weekly template.
  - `materialized_through` is the rolling horizon - the extension cron generates new appointments beyond this point.
- `appointments(id, patient_id, therapist_id, start_time TIMESTAMPTZ, end_time TIMESTAMPTZ, status, series_id NULLABLE, created_at, updated_at)`

### Key index (the one that matters)

```sql
CREATE UNIQUE INDEX "appt_therapist_start_active_uq"
  ON "appointments" ("therapist_id", "start_time")
  WHERE status <> 'cancelled';
```

**Why partial (`WHERE status <> 'cancelled'`)?** Because a cancelled appointment must not block a fresh booking at the same slot. Without the `WHERE`, cancelling and rebooking would fail with a duplicate-key error.

**Why is this the most important line in the whole codebase?** It is the single guarantee that no two active appointments can occupy the same `(therapist, start_time)` - no matter how the application code fails, races, or is redeployed. Redis holds and Redlock reduce contention and give clean error responses; this index is what makes correctness a *property of the system*, not of the code.

### Auth flow

1. `POST /auth/login` → verify email/password (bcrypt), look up user's profile row (`patients` or `therapists`), sign JWT with payload `{ sub, role, profileId, email, name }`.
2. `authenticate` middleware reads `Authorization: Bearer <jwt>`, verifies, attaches `req.user`.
3. `authorize("PATIENT" | ...)` - role guard. Reused on every downstream mutation.

**Why `profileId` in the JWT?** Every downstream handler needs "which patient/therapist is acting?" not "which user account?". Baking it into the token saves a DB lookup per request. Trade-off: tokens are stale after profile changes, but profiles are effectively immutable in this system.

### Seed script

Idempotent (`onConflictDoUpdate`), safe to re-run any time. Wipes and re-inserts each therapist's schedule on every run so schema drift can't leave stale rows.

Seeds:
- Two patients: `patient@test.com` (Priya) and `patient2@test.com` (Paul) - cross-patient conflict tests work out of the box.
- Two therapists with **complementary** schedules so patients see a real choice:
  - `therapist@test.com` - **Dr. Tanuj Therapist** (15 slots) - Mon/Tue/Thu/Fri afternoons, matches the assignment's example table verbatim.
  - `therapist2@test.com` - **Dr. Maya Mehta** (16 slots) - early mornings on Mon, the whole of Wed, Fri evenings, and both weekend mornings. Deliberately covers days/times Tanuj doesn't so smoke tests and demo flows can compare two independent availability projections.

All accounts use password `123456`.

---

## Phase 2 - Availability & Holds

### Goals
1. Dynamically derive slots from the schedule - never pre-seed.
2. Let a patient hold a slot for a configurable TTL (default 60s), atomically across the 3 clusters.
3. Ensure the hold survives a page refresh.
4. Return per-slot status so the UI can render `available | held_by_me | held_by_other | booked`.

### Slot generation algorithm

Implemented in [`backend/src/availability/service.ts`](./backend/src/availability/service.ts).

```
inputs:  therapistId, fromDate, toDate (YYYY-MM-DD in APP_TZ),
         optional requestingPatientId

1. Validate: range non-negative, spans ≤ AVAILABILITY_MAX_DAYS.
2. Fetch all schedule rows for the therapist (one query).
3. For each day D in [from..to]:
     dow = dayjs.tz(D, APP_TZ).day()
     for each schedule row with dayOfWeek == dow:
       slotStart = combineDateAndTimeInAppTz(D, row.startTime)  // UTC Date
       slotEnd   = combineDateAndTimeInAppTz(D, row.endTime)
       if slotStart is in the past: skip
       push { scheduleId, startISO, endISO }
4. One SQL query: booked appointments in [firstSlot..lastSlot] with status != 'cancelled'.
5. One Redis MGET across all candidate hold keys.
6. Map candidates → slot output:
     if in bookedSet   -> booked
     elif holdValue exists:
        if holdValue == requestingPatientId -> held_by_me
        else                                -> held_by_other
     else -> available
```

Complexity: **1 DB query + 1 Redis MGET** regardless of range size, plus one linear pass over candidates.

**Why not derive slots per-request from the DB using a generate_series query?** Two reasons: (a) time-of-day + day-of-week logic on the client's timezone is much cleaner in JS than PL/pgSQL; (b) the schedule table has ~15 rows for a full week - the work is trivially cheap in memory.

### Hold semantics

Design invariants:
- **A patient may hold at most one slot at a time.** Simplifies UX ("Hold → confirm → done") and makes the reverse index (`patient:hold:{patientId}`) a scalar, not a set.
- **A slot may be held by at most one patient at a time.** Enforced by `SET NX`.
- **Both invariants must hold atomically.** Enforced via Lua script - see below.

### Redis key layout

| Key | Value | TTL | Purpose |
|---|---|---|---|
| `hold:{therapistId}:{startTimeISO}` | `{patientId}` | `HOLD_TTL_SECONDS` (60) | Slot-side hold |
| `patient:hold:{patientId}` | `{"therapistId","startTime","endTime","holdKey"}` JSON | matching | Reverse index for `/holds/mine` + refresh survival |
| `lock:appt:{therapistId}:{startTimeISO}` | (Redlock-managed) | ≤10s | Booking critical section (Phase 3) |
| `idem:{patientId}:{key}` | Cached JSON `{status, body}` | 24h | Idempotency response cache (Phase 3) |

### Atomicity via Lua

Three custom Redis commands (registered via `redis.defineCommand`) in [`backend/src/redis.ts`](./backend/src/redis.ts):

**`acquireHold(slotKey, patientKey, patientId, ttl, reverseValue)`** - the entire hold acquisition is one atomic script:
```
if EXISTS(patientKey)                  return -1   # patient already holds something
if SET NX EX slotKey <patientId> fails return  0   # slot already held by someone else
SET EX patientKey <reverseValue>
                                       return  1   # acquired
```
Doing this without Lua would require two round-trips and expose the window where a slot key was set but the reverse key wasn't - a partial state we'd have to clean up.

**`releaseHold(slotKey, patientKey, patientId)`** - protects against the "expired-then-reused" race: the caller must still be the owner of the slot key at the moment of deletion. If TTL expired and another patient grabbed the slot, a late DELETE from the original holder is a no-op.

**`consumeHold(slotKey, patientKey, patientId)`** - semantically the same as release, but named separately because it means "convert hold → booking" in Phase 3. Return value drives the 410 Gone response when the hold has already expired.

### Availability × Holds cross-cutting behavior

- Patient A holds slot X → GET `/availability` for A: X is `held_by_me`. For B: X is `held_by_other`. For therapist: `held_by_other`.
- Hold TTL expires → next `/availability` call: X is back to `available` (no hold key in Redis, no booked row in DB).
- Patient A holds X, then releases → X back to `available`.
- Slot validation: `POST /holds` server-side verifies `(therapistId, startTime, endTime)` matches an actual schedule row + is in the future. Prevents a client from holding arbitrary time windows.

### Test coverage (Phase 2)

`backend/scripts/smoke-phase2.mjs` - 16 assertions across:
- login for all 3 personas
- list therapists + read schedule
- default 7-day availability window
- hold create with correct TTL
- refresh survival via `/holds/mine`
- one-hold-per-patient invariant
- per-role `held_by_me` vs `held_by_other`
- cross-patient slot conflict
- independent hold on a different slot
- release + availability transition back to available
- RBAC (therapist can't POST /holds)

---

## Phase 3 - Booking (one-time)

### Goals
1. Confirm a held slot as a scheduled appointment, safely under concurrent load across 3 clusters.
2. Guarantee **idempotency** - retries, double-clicks, and duplicate cluster delivery must never produce two rows.
3. Provide the primitives for Phase 4 (recurring): the same booking logic will be reused per occurrence.
4. Cancel a one-time appointment.

### Three-layer defense against double-booking

Every layer independently prevents the same failure. If any two fail, the third still holds. Presented in the order the request encounters them:

| # | Layer | Where | Catches |
|---|---|---|---|
| 1 | **Hold ownership + Lua `consumeHold`** | Redis | 99% of races: only the patient who holds the slot can book it, and consuming is atomic. If the hold expired or belongs to someone else, `consumeHold` returns `0` → 410 Gone. |
| 2 | **Redlock** on `lock:appt:{therapist}:{startTime}` | Redis | Two API workers on different clusters processing simultaneously; also lets us return a clean 409 instead of a raw SQL error. |
| 3 | **Partial unique index** `(therapist_id, start_time) WHERE status<>'cancelled'` | Postgres | Any residual race - clock skew on Redlock, an assumption breaking, a code path we didn't foresee. Postgres throws `23505`; we catch it and map to 409. |

The Phase 3 smoke run **passed 20/20 assertions without ever hitting layer 3**. The DB constraint remains present as an invariant, not a hot path.

### Booking flow ([`backend/src/appointments/service.ts`](./backend/src/appointments/service.ts))

```
POST /appointments  (Idempotency-Key required)
├── withIdempotency(patientId, key, fn):
│    ├── if Redis idem:{patientId}:{key} hit → return cached response
│    ├── acquire Redlock idem-lock:{patientId}:{key} (15s TTL)
│    ├── recheck cache under lock
│    ├── fn():
│    │    ├── acquire Redlock lock:appt:{therapist}:{start} (8s TTL)
│    │    ├── consumeHold(slotKey, patientKey, patientId)  # Lua, atomic
│    │    │    ├── returns 1 → proceed
│    │    │    └── returns 0 → look up: booked? → 409 : 410 Gone
│    │    ├── INSERT INTO appointments … RETURNING *
│    │    │    └── on 23505 unique_violation → 409 Conflict
│    │    └── release book lock
│    ├── cache { status, body } in Redis (TTL 24h)
│    └── release idem lock
└── return response (+ Idempotent-Replay: true on cache hit)
```

### Idempotency implementation ([`backend/src/lib/idempotency.ts`](./backend/src/lib/idempotency.ts))

- **Header contract**: `Idempotency-Key: <8..128 char string>` required on `POST /appointments`. Missing → 400.
- **Cache shape**: `{ status, body }` - the *full* response is stored, so retries see the exact same status + body (including error responses). This matters: if the first attempt returned 409, the retry should also return 409, not silently succeed.
- **Double-check-under-lock**: fast path checks the cache without a lock (99% of the time it either hits or is a fresh key). If it misses, we take a Redlock so only one of the 3 clusters actually runs the handler for this key; the other clusters wait for the lock, then read the fresh cache entry on their retry.
- **Lock TTL 15s** vs **book lock TTL 8s** - the outer idem lock outlives the inner book lock so the sequence completes cleanly.
- **Response reuse via `Idempotent-Replay: true` header** - clients can detect that a response came from the cache (useful for the frontend to skip UI animations on retry).

### Distributed lock choice: `redlock` v5

- Even with a single Redis node (our setup), Redlock still gives correct mutual exclusion across the 3 stateless API clusters - which is exactly the concurrency case the assignment cares about.
- Configuration:
  - `retryCount: 8`, `retryDelay: 100ms`, `retryJitter: 100ms` → up to ~800ms of contention wait before surfacing a lock error. Booking is interactive, so bounded tail latency matters.
  - `driftFactor: 0.01` - Redlock's official recommendation for accounting for clock skew.
- The known theoretical criticism of Redlock (Kleppmann's fencing token argument) is **not a concern here** because we have a downstream `UNIQUE` constraint on Postgres - even if Redlock were somehow bypassed, the DB rejects duplicates. This is the classic "lock as a performance optimization, DB constraint as the correctness guarantee" pattern.

### Cancellation semantics

- `DELETE /appointments/:id` - patient cancels their own scheduled appointment.
- Guards: `403` if not owner; `400` if already `completed`/`no_show`; `400` if `start_time` has passed.
- Sets `status = 'cancelled'` - row remains for audit. Because the unique index is partial (`WHERE status <> 'cancelled'`), the slot is immediately re-bookable.
- **Single-instance cancel of a recurring appointment** works with this same endpoint (row-level update, `series_id` untouched). Whole-series cancel is a separate Phase 4 endpoint.

### Interesting edge cases handled

1. **Patient double-clicks Confirm** → same idempotency key on both requests → both return the same appointment id → **exactly one row** in `appointments`. Verified by inspecting the response ids AND querying the DB.
2. **Patient B racing Patient A for the same slot** → Patient B is stopped at the hold step (only one hold key can exist). If somehow B got past that, the DB unique index still catches it.
3. **Hold expired between hold and confirm** → `consumeHold` returns `0`. We do a targeted DB check: if the slot is now booked by someone else, return 409 (`Slot already booked`); otherwise return 410 (`Hold expired`). This gives the client a specific, actionable error.
4. **Confirm without ever holding** → same code path as expired hold → 410 Gone.
5. **Cancel someone else's appointment** → 403. Ownership check is on `patient_id`.

### Test coverage (Phase 3)

`backend/scripts/smoke-phase3.mjs` - 20 assertions across 5 scenarios:

1. **Happy path + idempotency** - book, replay with same key returns identical id + `Idempotent-Replay: true`. Missing key → 400.
2. **Cross-patient race** - two patients try same slot simultaneously (both hold + book concurrently). Exactly one 201, one 409.
3. **Double-click same key** - two parallel requests with same idempotency key on the same fresh hold → both return the same appointment id, DB has exactly one row.
4. **Cancel** - cancel own appointment (200), slot becomes `available` again in `/availability`. Cancel someone else's → 403.
5. **Confirm without hold** → 410 Gone.

---

_Phase 4 will layer on top of `bookOneTimeAppointment` for recurring - the per-occurrence booking uses the same protection stack, wrapped in a series-level transaction and conflict pre-check._

---

## Phase 4 - Recurring Series

### Goals
1. Accept `POST /appointments` with a `recurrence` block to create a full series in one shot.
2. Support `daily | weekly | biweekly | monthly` with a rolling 90-day materialization horizon and optional patient-supplied `endDate`.
3. Pre-check every occurrence for conflicts (existing appointments **or** active holds by another patient) and reject atomically if any conflict - no partial series.
4. Two cancel semantics:
   - **Single instance cancel** - leaves the series active; other occurrences untouched.
   - **Whole-series cancel** - flags every future non-cancelled instance in one SQL statement + marks the series inactive.
5. Idempotent nightly cron that extends every active series so the horizon stays full without generating infinite rows up-front.

### Occurrence enumeration ([`backend/src/series/frequency.ts`](./backend/src/series/frequency.ts))

Anchor-relative, not cursor-relative:

```ts
for (let i = 0; i < MAX_ITER; i++) {
  const start = anchor.add(i, unit).toDate();      // <-- always from anchor
  if (dayjs(start).isAfter(horizon)) break;
  push { start, end: start + duration };
}
```

**Why anchor-relative and not `cursor.add(1, unit)` in a loop?** Month arithmetic drifts otherwise. Jan 31 + 1 month = Feb 28; Feb 28 + 1 month = Mar 28 (not Mar 31). By always computing from the anchor, `anchor.add(2, 'month')` = Mar 31, keeping the series aligned to the original day-of-month whenever possible. dayjs handles the clamping cases (e.g., Jan 31 monthly falling on Feb → Feb 28) correctly with this pattern.

Frequencies map to dayjs units:
- `daily` → `anchor.add(i, 'day')`
- `weekly` → `anchor.add(i, 'week')`
- `biweekly` → `anchor.add(i * 2, 'week')`
- `monthly` → `anchor.add(i, 'month')`

`MAX_ITER = 4000` is a safety cap in case of pathological input (should never be hit - 90d / minimum daily = 90 occurrences).

### Schedule-alignment filter

Not every generated occurrence is bookable. Concretely:
- **Weekly / biweekly** - same day-of-week + time-of-day as the anchor → always aligned if the anchor is.
- **Daily** - may land on Wednesday or the weekend, when the seeded therapist doesn't work. Skip those.
- **Monthly** - may land on any day-of-week. Skip if it doesn't match a schedule row.

Implementation: `occurrenceMatchesSchedule(occ, windows)` looks for any schedule row where `dayOfWeek` matches and the (start, end) time-of-day in `APP_TZ` matches exactly. Anything else is filtered out and counted as `skipped` in the response, so the UI can show "N booked, M skipped due to schedule."

Verified in the Phase 4 smoke test: a `daily` series anchored Thursday 9:00 UTC produced **38 booked, 52 skipped** over 90 days - exactly the expected count given the seeded Mon/Tue/Thu/Fri template.

### Conflict pre-check (batched)

```ts
const [booked, holdValues] = await Promise.all([
  db.select({...}).from(appointments).where(and(
    eq(appointments.therapistId, ...),
    inArray(appointments.startTime, allOccurrenceStartDates),
    ne(appointments.status, 'cancelled')
  )),
  redis.mget(...allOccurrenceHoldKeys),
]);
```

- **One DB query** - `inArray` maps to `WHERE start_time = ANY($1::timestamptz[])`, so it's a single index lookup.
- **One Redis round-trip** - `MGET` across all occurrence hold keys.
- A hold key owned by the requesting patient (unlikely except for the anchor itself) is *not* counted as a conflict; only other patients count.
- Conflicts are returned in the 409 response body under `error.details.conflicts` so the client can highlight which dates are blocked. Verified in the smoke test.

### Booking flow ([`backend/src/series/service.ts`](./backend/src/series/service.ts))

```
POST /appointments  { recurrence: {...} }
├── withIdempotency( patientId, key, fn ):
│    └── fn():
│         ├── peek Redis: anchor hold owner == patientId ?  (410 Gone if not)
│         ├── enumerate occurrences up to min(anchor + 90d, endDate)
│         ├── filter by schedule alignment  → validOccurrences, skipped count
│         ├── pre-check conflicts (batched DB + Redis)
│         │    └── conflicts.length > 0  → 409 + details
│         ├── db.transaction:
│         │    ├── INSERT recurring_series RETURNING *
│         │    ├── INSERT appointments × N with series_id
│         │    └── on 23505 → rollback → 409 (race that slipped past pre-check)
│         └── best-effort consumeHold(anchor)  (harmless if it fails - TTL cleans up)
└── cache { status, body }  (24h TTL)
```

### Locking strategy for series

Deliberately *not* using per-slot Redlock on all N occurrences. Rationale:
- Acquiring N locks risks deadlock if two overlapping series booking attempts race (A wants locks 1..10, B wants 5..15, both hold some, both wait).
- Sorted acquisition would fix that but adds complexity for very little marginal benefit.
- The outer `withIdempotency` Redlock already prevents same-patient duplicate submissions.
- The DB unique index still catches any cross-patient race that beats the pre-check.

If the pre-check passes but the transaction fails with `23505`, we return a clean 409 to the caller and they can retry - same UX as a "series conflict" 409, just triggered by the DB rather than the pre-check.

### Cancel semantics

**Single instance** - the existing `DELETE /appointments/:id` from Phase 3 works unchanged. It sets `status = 'cancelled'`, leaves `series_id` in place. The series stays active. Verified.

**Whole series** - `DELETE /series/:id`:

```sql
UPDATE appointments
SET status = 'cancelled', updated_at = NOW()
WHERE series_id = $1
  AND start_time >= NOW()
  AND status NOT IN ('cancelled', 'completed', 'no_show');

UPDATE recurring_series SET active = false WHERE id = $1;
```

- Only future non-terminal appointments are affected - past `completed`/`no_show`/already-cancelled rows are preserved for audit.
- Setting `active = false` prevents the extension cron from re-materializing new occurrences.

### Extension cron ([`backend/src/series/cron.ts`](./backend/src/series/cron.ts))

- Schedule: `0 2 * * *` (2 AM daily in the server TZ).
- **Guarded by a Redlock** on `cron:extend-series` - even though all 3 clusters run the same schedule, only one holds the lock and does the work per night. The other two log "another cluster owns it" and no-op.
- For each active series: enumerate new occurrences beyond `materialized_through`, filter by schedule, insert (catching `23505` and skipping conflicts - cron must not fail loudly on user-caused edge cases).
- Idempotent by design: re-running immediately produces 0 new rows. Verified in the smoke test (`extend1.appointmentsCreated == 0` and `extend2.appointmentsCreated == 0` once horizon is full).
- Also exposed as `POST /series/extend` for manual triggering (used by the smoke test; useful in ops).

### Non-obvious edge cases handled

1. **Monthly clamping** - Jan 31 monthly → Feb 28, Mar 31, Apr 30 (dayjs handles this correctly via anchor-relative addition).
2. **Anchor doesn't align to schedule** - cannot happen because Phase 2's hold acquisition already validated the anchor. We still assert `hasAnchor` in the valid list as a belt-and-braces check.
3. **`endDate` before horizon** - series stops early. Extension cron respects `endDate` and never materializes past it.
4. **Extension cron across 3 clusters** - Redlock on `cron:extend-series` guarantees exactly one runs per night.
5. **Series cancel doesn't undo past completed/no_show** - the `NOT IN (completed, no_show)` filter preserves audit history.
6. **Pre-check race** - DB unique index is the safety net; unique_violation rolls back the whole transaction cleanly.

### Test coverage (Phase 4)

`backend/scripts/smoke-phase4.mjs` - 7 scenarios, ~20 assertions:

0. **Setup for conflict**: B books a one-time exactly 7 days after A's anchor.
1. **Happy-path weekly**: A books weekly → 13 occurrences, same `series_id`, all 7-day gaps.
2. **Idempotency replay**: same key → same series id + `Idempotent-Replay: true`.
3. **Series conflict pre-check** (moved to scenario 0/pre-1): A's weekly recurrence would hit B's one-time → 409 with `conflicts` array.
4. **Cancel single instance**: 1 cancelled, `series_id` intact, series still active.
5. **Cancel whole series**: N future appointments cancelled, series `active = false`. RBAC: cancelling someone else's series → 403.
6. **Daily skipping**: anchored on Thursday → 38 booked, 52 skipped over 90d (only Mon/Tue/Thu/Fri exist in the seeded schedule).
7. **Cron extension idempotency**: two consecutive extend runs; the second creates 0 rows.

---

_Phase 5 will add the therapist side: reading assigned appointments, window-guarded status updates, and schedule updates that (per the assignment) MUST NOT affect existing bookings - which is trivially true given the schedule-as-template design from Phase 1._

---

## Phase 5 - Therapist Flows

### Goals
1. Therapist can list appointments assigned to them, joined with patient name.
2. Therapist can transition an appointment to `completed | no_show | cancelled` - but **only during the appointment window** (per assignment).
3. Therapist can update their weekly schedule, and **existing appointments MUST be unaffected**.

### New routes

| Method | Path | Role | Notes |
|---|---|---|---|
| `GET` | `/therapist/appointments?from=&to=` | THERAPIST | Assigned appointments joined with patient name |
| `GET` | `/therapist/schedule` | THERAPIST | Read own schedule |
| `PUT` | `/therapist/schedule` | THERAPIST | Replace entire weekly template |
| `PATCH` | `/appointments/:id/status` | THERAPIST | `completed \| no_show \| cancelled` - window-guarded |

Route name `/therapist` (singular) intentionally distinct from `/therapists` (plural, patient-facing list) to avoid confusion - one is "the acting therapist's own routes", the other is "look up any therapist".

### Status update rules ([`backend/src/appointments/service.ts`](./backend/src/appointments/service.ts) → `updateAppointmentStatusByTherapist`)

- **RBAC**: therapist role required (403 otherwise) AND must be the assigned therapist (403 for other therapists).
- **Terminal statuses are immutable**: `completed | no_show | cancelled` cannot transition anywhere else. Only `scheduled` is a valid *source*.
- **Window guard**: `now` must satisfy `start_time <= now <= end_time`. Enforced by the service, not schema.
- Both terminal-transition and window-guard errors return 400 with a specific message.

### Schedule update rules ([`backend/src/therapist/service.ts`](./backend/src/therapist/service.ts) → `replaceSchedule`)

- **RBAC**: only the therapist themselves - endpoint uses `req.user.profileId` from the JWT.
- **Validation**:
  - `dayOfWeek ∈ [0, 6]`
  - `HH:mm` regex, `end > start`
  - **No overlapping windows within the same day** - validated by sorting windows per day and checking `windows[i].start >= windows[i-1].end`
- **Atomic replace** - done in a single DB transaction: `DELETE WHERE therapist_id = ?` then `INSERT` all new rows. Either both succeed or both roll back.

### Why "schedule update doesn't affect existing bookings" is trivially true

This is worth spelling out because it's a specific correctness requirement in the assignment:

- The `schedules` table is a **template**, not a source of truth for booked appointments.
- Every `appointments` row carries its own concrete `start_time TIMESTAMPTZ` and `end_time TIMESTAMPTZ` - no foreign key or reference to `schedules`.
- The availability endpoint (Phase 2) is the *only* consumer of `schedules`, and it uses them to project available slots on the fly.
- Consequences:
  - Deleting a schedule row **cannot** cascade to appointments (no FK).
  - Replacing all schedule rows leaves all existing appointment rows byte-for-byte identical.
  - The therapist may still `complete`/`no_show`/`cancel` an appointment whose time no longer falls on any schedule window - it doesn't matter, the appointment is a materialized fact.

The Phase 5 smoke test proves this end-to-end: snapshot the appointment list, replace the entire schedule with Sundays-only, snapshot again - every appointment id, `start_time`, and `status` is byte-identical. Then verify the availability endpoint immediately reflects the new schedule (no old-day slots offered).

### Interaction with holds during a schedule change

An active hold on a slot that was just removed from the schedule remains valid until its TTL expires. If the patient confirms in time, they get their booking; the DB constraint doesn't care whether the schedule template still contains that window. If they don't confirm, the hold expires naturally.

I considered invalidating holds on schedule replace but decided against it: (a) the hold TTL is short (60s), so the effect is bounded; (b) invalidation would need to scan Redis for `hold:{therapistId}:*` keys, which is O(N) and not worth the complexity for such a rare interleaving.

### Test coverage (Phase 5)

`backend/scripts/smoke-phase5.mjs` - 22 assertions across 6 scenarios:

1. `GET /therapist/appointments` returns joined patient name; patient role gets 403.
2. `PATCH /appointments/:id/status` **before** the window opens → 400.
3. Backdate the row via `pg` client (`UPDATE appointments SET start_time = NOW() - 1min ...`); patient PATCH → 403; therapist PATCH `completed` → 200.
4. Re-PATCH a `completed` row → 400 (terminal is terminal).
5. Snapshot appointments → replace schedule with Sundays-only → snapshot again. Assert per-appointment `id`, `start_time`, `status` unchanged. Also assert `/availability` reflects the *new* schedule (only Sunday day-of-week).
6. Schedule validation: overlapping windows → 400; inverted times → 400.

---

_The backend is now feature-complete for both roles. Phase 6 will build the React frontend consuming these endpoints._

---

## Phase 6 - Frontend

Single-page React app that consumes every backend endpoint. Split into three sub-phases:
- **6a** - scaffold + auth shell + login
- **6b** - patient dashboard (availability + holds + booking + my bookings)
- **6c** - therapist dashboard (assigned appointments + status update + schedule editor)

### Stack

| Concern | Choice | Why |
|---|---|---|
| Bundler / dev server | **Vite 5** | Fastest DX, ESM-native, zero config for React+TS |
| Framework | **React 18** | Ubiquitous, matches the JD |
| Routing | **React Router 6** | Straightforward nested routes + programmatic navigation |
| Server state | **TanStack Query 5** | Handles caching, deduping, invalidation - critical for booking flows |
| Client state | **Zustand** (with `persist` middleware) | Auth token + user need to survive refreshes; Zustand + `localStorage` is 20 lines |
| Styling | **Tailwind 3.4** | Design velocity + consistency without inventing a component library |
| Dates | **dayjs** with `utc`, `timezone`, `relativeTime` | Mirrors backend `APP_TZ` choice; tiny bundle vs. moment |
| Type safety | **TypeScript** strict, one shared `types/api.ts` mirroring backend DTOs |

Deliberately avoided: form libraries (RHF/Formik) - every form here is 2-3 fields; UI kits (MUI/Chakra) - heavy and would clash with brand style. Tailwind + a handful of `@apply` component classes (`.card`, `.btn-primary`, `.input`) is enough.

### Design language

- **Palette**: brand teal (`#0d9488`) + slate greys. Warm, calming - matches Wysa's mental-health positioning.
- **Type**: Inter, weights 400/500/600/700.
- **Layout**: 6 xl container, generous padding, rounded-2xl cards with a soft two-layer shadow.
- **Motion**: 200 ms fade-in on modals & banners; the hold countdown bar animates smoothly from full to empty.
- **Accessibility**: focus rings on every interactive element; modal traps Escape; buttons carry `aria-label` where the icon is the only affordance.

### Shared foundation

- `lib/api.ts` - typed `fetch` wrapper that reads the token from Zustand, injects `Authorization`/`Idempotency-Key`, and throws a structured `ApiError { status, code, message, details }`. On 401 it clears the local session so the router redirects to `/login` on the next render.
- `lib/queryClient.ts` - retries 4xx never, others twice, 15 s `staleTime`, `refetchOnWindowFocus: false`.
- `lib/time.ts` - mirrors backend `APP_TZ`, exposes `fmtDay`, `fmtTime`, `fmtRange`, `groupByDay`.
- `store/auth.ts` - `{ token, user, login, logout }`, persisted to `localStorage` under `wysa.auth`.
- `components/ProtectedRoute.tsx` - redirects unauthed users to `/login` and cross-role users to their own dashboard.
- `components/Modal.tsx` - accessible overlay with backdrop click + Escape to close.
- `components/Toast.tsx` - tiny Zustand-backed toast bus (`toast.success/error/info`) rendered by a single `<ToastHost />` at the app root; auto-dismisses after ~4 s.

### Idempotency on the client

Every booking `POST` generates a fresh UUID v4 via `crypto.randomUUID()` (`newIdempotencyKey()`) and sends it as `Idempotency-Key`. This makes React Query's automatic retries safe - the server dedupes by key + patient - and it also protects against the double-click case. The key is scoped to the mutation call, so a retry uses the same key while a *fresh* booking attempt gets a new one.

### Patient dashboard ([`routes/PatientDashboard.tsx`](./frontend/src/routes/PatientDashboard.tsx))

Two tabs: **Find a slot** and **My bookings**. Above the tabs, a **sticky HoldBanner** appears whenever there's an active hold. Tabs are hash-linkable (`#bookings`) for easy deep-linking / dev screenshotting.

#### AvailabilityView
- Therapist dropdown (defaults to first therapist).
- Range chips: **7 / 14 / 30 days**.
- Fetches `GET /availability?therapistId=&from=YYYY-MM-DD&to=YYYY-MM-DD`.
- Slots grouped by day; each slot is a chip whose color + interactivity depends on `SlotStatus`:
  - `available` → white bg, hover ring, clickable
  - `held_by_me` → brand fill, disabled
  - `held_by_other` → amber
  - `booked` → slate + disabled
- Click `available` → `POST /holds` via `useCreateHold` mutation. On success, React Query invalidates `myHold` and `availability` queries - the banner appears and the chip flips to `held_by_me` in one render.

**Bug caught during first screenshot**: the initial version sent full ISO timestamps for `from`/`to`, but the backend zod schema requires `YYYY-MM-DD`. The 400 was being swallowed into the "no slots" empty state. Fix was two-part: (1) format params correctly on the client, (2) surface `error` from `useQuery` in the UI so future failures are visible instead of silent.

#### HoldBanner
- Reads `GET /holds/mine`. Runs a `setInterval(..., 1000)` **only while a hold exists** so the countdown is live but doesn't waste cycles when idle.
- Progress bar goes brand → amber (≤25 s) → rose (≤10 s) - a subtle escalation cue.
- When the countdown hits 0, it invalidates the hold + availability queries (server-side TTL has expired, so the next fetch will return `null` and the banner will unmount).
- **Confirm** opens `BookingModal`; **Release** calls `DELETE /holds/mine`.

#### BookingModal
- Two large radio-style tiles for **One-time** vs **Recurring**.
- If recurring: radio group over `weekly / biweekly / monthly / daily`, optional end-date picker (default: hidden; when enabled defaults to `anchor + 3 months`).
- Submit posts to `POST /appointments` with the appropriate body and a fresh `Idempotency-Key`.
- Server errors (`SLOT_TAKEN`, `HOLD_EXPIRED`, `SERIES_CONFLICT`) surface as inline error text in the modal so the user can decide their next step without losing their form state.
- On success: toast + invalidate holds + availability + appointments + series.

#### MyBookings
- Three sections:
  1. **Upcoming** - future scheduled appointments; each row shows date badge, time range, therapist, series-badge if applicable, and a Cancel button.
  2. **Recurring series** - active series with frequency, anchor time, therapist, upcoming-instance count, and a Cancel-series button.
  3. **Recent history** - last 20 terminal-status or past appointments (read-only).
- Cancel confirmations use `<Modal>` and show the **number of future instances** that will be cancelled for series, which is derived client-side by filtering appointments by `seriesId + startTime > now`.

### Therapist dashboard ([`routes/TherapistDashboard.tsx`](./frontend/src/routes/TherapistDashboard.tsx))

Two tabs: **Appointments** and **Weekly schedule**. Hash-linkable the same way.

#### AssignedAppointments
- `GET /therapist/appointments` with a 30 s auto-refresh (`refetchInterval`).
- Also runs a client-side 30 s tick to re-evaluate the *window-open* state for each row - this way "Mark completed" enables/disables in near-real-time without requiring a full refetch.
- Filter chips **Upcoming / Today / Past**.
- Each row shows an initials avatar (chosen instead of a generic user icon - feels more human), patient name, time range, and status badge.
- **Status action buttons** are only rendered when `status === "scheduled" && now ∈ [start, end)`. Outside the window, a small italic hint explains why: "Available in 2 hours" or "Window closed 3 hours ago" (uses `dayjs().from(...)`). The button click posts `PATCH /appointments/:id/status`.

#### ScheduleEditor
- `GET /therapist/schedule` seeds the draft state; a `useEffect` re-syncs when the server data changes.
- Seven day rows (Sun-Sat), each with a list of `<input type="time">` pairs and an **Add window** button. Removal is inline.
- **Client-side validation** mirrors the server: `end > start`; no overlapping windows within a day (windows sorted by start; adjacent pairs checked). Any violation renders in a red list and disables Save.
- `isDirty` diff (normalized string sort) drives the Save/Discard button state - no unnecessary PUTs.
- Save calls `PUT /therapist/schedule` with the full array. The information card at the top reminds the therapist that **existing appointments are unaffected** - that's the assignment's requirement, so it's worth making it explicit in the UI.

##### Time-format contract for `/therapist/schedule`

Postgres `time` columns serialize as `"HH:MM:SS"` through the `pg` driver. To avoid every consumer having to strip the `:SS` suffix (and to be tolerant of direct API callers like Postman), the API normalizes on both sides:

- `GET /therapist/schedule` truncates every `startTime`/`endTime` to `HH:MM` (in `getOwnSchedule` service).
- `PUT /therapist/schedule` accepts `HH:MM` **or** `HH:MM:SS` via a Zod `.transform()` that slices to `HH:MM` before it reaches the service.

Regex used: `^([0-1]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$`. Invalid formats (e.g. `"25:00"`, `"1:0"`) are still rejected with `VALIDATION_ERROR` and a clear "Expected HH:MM or HH:MM:SS" message.

### File layout

```
frontend/
├─ index.html
├─ vite.config.ts · tsconfig.json · tailwind.config.cjs · postcss.config.cjs
├─ src/
│  ├─ main.tsx · App.tsx · index.css
│  ├─ types/api.ts               ← DTOs mirroring backend responses
│  ├─ lib/
│  │  ├─ api.ts                  ← fetch wrapper + ApiError + newIdempotencyKey
│  │  ├─ queryClient.ts
│  │  └─ time.ts                 ← dayjs with APP_TZ + formatters
│  ├─ store/auth.ts              ← Zustand + persist
│  ├─ components/
│  │  ├─ Layout.tsx · ProtectedRoute.tsx
│  │  ├─ Modal.tsx · Toast.tsx · Spinner.tsx
│  ├─ features/
│  │  ├─ patient/
│  │  │  ├─ api.ts               ← useQuery/useMutation hooks
│  │  │  ├─ AvailabilityView.tsx · HoldBanner.tsx
│  │  │  ├─ BookingModal.tsx · MyBookings.tsx
│  │  └─ therapist/
│  │     ├─ api.ts
│  │     ├─ AssignedAppointments.tsx · ScheduleEditor.tsx
│  └─ routes/
│     ├─ Login.tsx · PatientDashboard.tsx · TherapistDashboard.tsx
```

### Bundle

Production build: `261 KB` JS (`82 KB` gzipped) + `25 KB` CSS (`4.7 KB` gzipped). Well within a comfortable range for a single-purpose SPA.

---

## Phase 7 - Hardening

Pre-deployment audit + fixes. Goal: catch every "the internet is a hostile place" issue before shipping. The focus areas from the assignment are **rate limiting, input validation, error handling, CORS, security headers, logs** - this section walks through what was already in place, what was gappy, and what changed.

### Baseline audit

| Area | Before | Notes |
|---|---|---|
| CSP / XSS / clickjacking / MIME sniffing | `helmet()` with defaults | ✅ Good. Adds `X-Content-Type-Options`, `X-Frame-Options`, HSTS (in prod), strict CSP. |
| Body size cap | `express.json({ limit: "100kb" })` | ✅ Small enough that a payload flood can't wedge memory. |
| CORS | Origin from env, single or comma-list | ✅ Kept - added explicit `allowedHeaders` and `exposedHeaders`. |
| Input validation | zod on every mutating body | ✅ Kept - added `zod` for **route params** (`:id` must be UUID). |
| Auth | JWT via `jsonwebtoken`, bcryptjs for passwords | ✅ Solid crypto choices. Added `iss` + `aud` claim verification. |
| Rate limiting | Single global limit (300/min) | ⚠ No per-endpoint tiering; `/auth/login` shared the loose global bucket → brute force friendly. |
| Trust proxy | Unset | ⚠ Behind Render/Vercel, `req.ip` would be the proxy IP → rate limits would bucket all users into one key. |
| Route params | Passed through unvalidated | ⚠ Non-UUID `:id` values hit the DB (small waste + surface area). |
| Error responses | Custom `AppError` + `ZodError` branch | ✅ Consistent envelope. Extended to never leak stack traces in prod. |
| Logs | pino default | ⚠ No redaction - `Authorization: Bearer <token>` could land in logs. |
| Maintenance endpoints | `/series/extend` open to any authed user | ⚠ Anyone with a JWT could trigger the cron manually. |

### Changes

#### 1. `trust proxy` - the invisible-until-it-bites setting

```1:11:backend/src/index.ts
import express from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
```

`app.set("trust proxy", config.TRUST_PROXY)` - set to `1` for a single reverse proxy (Render/Vercel/Nginx). Without this, every request appears to come from the proxy's IP, so every rate limit effectively becomes a global limit, and IP-keyed brute-force protection is worthless. Configurable so we can raise it if we ever add multiple hops.

#### 2. Rate-limit tiers ([`backend/src/lib/rateLimit.ts`](./backend/src/lib/rateLimit.ts))

Three named limiters, all keyed correctly for their purpose, all responding with the same `{ error: { code: "RATE_LIMITED", message } }` envelope so clients handle them uniformly:

| Limiter | Applied to | Key | Default | Reasoning |
|---|---|---|---|---|
| `globalLimiter` | `app.use(...)` | IP | 300/min | Safety net; catches anomalous traffic before it reaches per-route limiters |
| `authLimiter` | `POST /auth/login` | IP | 10/min | Brute-force ceiling. A real human logs in maybe 2-3× per minute at worst |
| `bookingLimiter` | `POST /holds`, `POST /appointments` | User (profileId), falls back to IP | 30/min | Prevents a compromised account from spamming the booking pipeline; falls back to IP so pre-auth 401s still get bucketed |

All thresholds are env-configurable (`RATE_LIMIT_GLOBAL_PER_MIN`, `RATE_LIMIT_AUTH_PER_MIN`, `RATE_LIMIT_BOOKING_PER_MIN`) so ops can tune without a redeploy.

`draft-7` `RateLimit-Policy` + `RateLimit-Remaining` headers are enabled so well-behaved clients can back off before they hit 429.

#### 3. Route param validation ([`backend/src/lib/validate.ts`](./backend/src/lib/validate.ts))

A tiny middleware factory + a `uuidParam(name)` schema. Applied to every route with an `:id` segment:

- `DELETE /appointments/:id`
- `PATCH /appointments/:id/status`
- `DELETE /series/:id`
- `GET /therapists/:id/schedule`

Non-UUID ids now return `400 VALIDATION_ERROR` before the DB is touched. Reduces attack surface (no crafted-id enumeration) and removes an easy DB-load vector.

#### 4. Idempotency-Key format

Tightened from "8-128 chars, any content" to a URL-safe alphabet regex: `^[A-Za-z0-9._~:-]{8,128}$`. Rejects headers with spaces, control chars, or weird characters early. UUID v4 (what the frontend generates) satisfies this trivially.

#### 5. JWT `iss`/`aud` claims ([`backend/src/auth/service.ts`](./backend/src/auth/service.ts))

`jwt.sign(...)` now sets `{ issuer: "wysa-api", audience: "wysa-clients" }`, and `jwt.verify(...)` demands the same values. This means a token signed for a different service (even if that service used the same secret by accident) will be rejected. Both values are env-driven so multi-tenant / multi-env setups can differ them.

#### 6. Log redaction ([`backend/src/lib/logger.ts`](./backend/src/lib/logger.ts))

Configured pino's `redact` to strip `authorization`, `cookie`, `x-admin-token`, `idempotency-key` headers and any field named `password`/`passwordHash`/`token`. Sensitive request headers now appear as `[REDACTED]` in log lines.

#### 7. Structured error envelope + no stack in prod ([`backend/src/lib/errors.ts`](./backend/src/lib/errors.ts))

Every response body has exactly the same shape:

```json
{ "error": { "code": "STRING_CODE", "message": "human message", "details": {...optional} } }
```

- `ZodError` → `code: "VALIDATION_ERROR"`, `details: flatten()` (fieldErrors + formErrors)
- `AppError` → `code`, `message`, optional `details`
- Anything else → `code: "INTERNAL"`, `message: "Internal server error"`. In dev, we also include `details.message` for easier debugging. **In prod, no stack, no message from the raw error is leaked.**
- All 5xx errors are logged at `error` level with the `reqId` so a client bug report can be traced to the exact log entry.

#### 8. Request IDs + smart HTTP logging ([`backend/src/index.ts`](./backend/src/index.ts))

- `pino-http` is configured with `genReqId` - echoes an incoming `X-Request-ID` if present, otherwise generates a UUID. The value is set on the response, so the client always has an id to include in bug reports.
- Health endpoint requests are excluded from access logs - `/health` gets hit every 30 s by uptime probes and the noise crowds real signal.
- Custom `customLogLevel` maps 5xx → `error`, 4xx → `warn`, 2xx/3xx → `info`. Makes log-based alerting straightforward.

#### 9. Maintenance endpoint hardening ([`backend/src/lib/adminGuard.ts`](./backend/src/lib/adminGuard.ts))

`POST /series/extend` is now behind `requireAdminToken`:
- If `ADMIN_TOKEN` env is unset → no-op (dev / smoke test ergonomic).
- If set (must be ≥ 16 chars) → requires an exact-match `X-Admin-Token` header, otherwise 403.

The header is in the pino redaction list, so a leak into logs is contained.

#### 10. CORS headers list

Explicitly enumerated `allowedHeaders` (`Content-Type`, `Authorization`, `Idempotency-Key`, `X-Admin-Token`) and `exposedHeaders` (`Idempotent-Replay`, `RateLimit-Remaining`, `Retry-After`). Preflight is cached for 10 minutes (`maxAge: 600`). This eliminates the "why is my Idempotency-Key header being stripped?" class of confusing errors.

### What was intentionally NOT added

- **Refresh tokens / short-lived access tokens**: out of scope for a take-home; the 7-day JWT is fine for a demo.
- **CSRF protection**: not needed - the API accepts `Authorization: Bearer` only, not cookies, so there's no ambient credential a CSRF could exploit.
- **Password strength meter / signup validation**: assignment doesn't include signup; seeded users have known passwords.
- **`redis` instance connection retries / circuit breaker**: ioredis handles this reasonably out of the box.
- **DB connection pool tuning**: default `pg` pool sizes are fine for the traffic profile.

### Test coverage (Phase 7)

`backend/scripts/smoke-phase7.mjs` - 22 assertions across 8 areas:

1. Security headers present (HSTS, X-Content-Type-Options, X-Frame-Options, `RateLimit-Policy`), custom `X-Request-ID` header round-trips.
2. Setup - grab a patient JWT before the auth-limit test drains the login bucket.
3. Zod validation errors → `{ code: "VALIDATION_ERROR", details: { fieldErrors } }`, structured per-field arrays.
4. Non-UUID route params rejected with 400 before the DB is queried (verified for `/appointments/:id`, `/series/:id`).
5. `Idempotency-Key` header format: too short → 400; contains spaces / `#` → 400.
6. Booking limiter: 40 rapid `POST /holds` from the same user produced 13 × 429 (limit = 30 default).
7. `/series/extend` accessible in dev when `ADMIN_TOKEN` is unset.
8. Auth limiter: 20 rapid `/auth/login` attempts from same IP → 11 × 429 (limit = 10 default).

All 22 assertions pass on a freshly booted backend (the in-memory limiter store resets on process restart, so run the script within a minute of `npm run dev` for deterministic results).

### Files added/changed

```
backend/src/
├─ config.ts                    ← new env vars for rate limits, TRUST_PROXY, ADMIN_TOKEN, JWT iss/aud
├─ index.ts                     ← trust proxy, refined helmet + cors, pino-http genReqId + level mapping
├─ auth/
│  ├─ service.ts                ← JWT sign/verify with iss + aud
│  └─ routes.ts                 ← authLimiter on /login; email max length
├─ lib/
│  ├─ rateLimit.ts    (new)     ← global, auth, booking limiters
│  ├─ validate.ts     (new)     ← uuidParam + validateParams middleware
│  ├─ adminGuard.ts   (new)     ← requireAdminToken
│  ├─ errors.ts                 ← consistent envelope, no stack in prod, reqId in error logs
│  └─ logger.ts                 ← pino redact paths
├─ holds/routes.ts              ← bookingLimiter
├─ appointments/routes.ts       ← bookingLimiter + validateParams + tighter Idempotency-Key regex
├─ series/routes.ts             ← validateParams + requireAdminToken on /extend
├─ therapists/routes.ts         ← validateParams for :id
backend/scripts/
├─ smoke-phase7.mjs   (new)     ← 22 assertions across 8 scenarios
```

Regression check: all Phase 3, 4, 5 smoke tests still pass unchanged.

---

## Phase 8 - Deployment

Ship the app to the internet on four free-tier managed services with zero infrastructure ops.

### Target architecture

```
                        ┌──────────────┐        ┌────────────────┐
    users ──HTTPS──▶    │    Vercel    │──API──▶│     Render     │
                        │  (frontend)  │        │   (backend)    │
                        └──────────────┘        └───────┬────────┘
                                                        │
                                       ┌────────────────┴────────────────┐
                                       ▼                                 ▼
                                ┌──────────────┐                 ┌──────────────┐
                                │     Neon     │                 │   Upstash    │
                                │  (Postgres)  │                 │   (Redis)    │
                                └──────────────┘                 └──────────────┘
```

Rationale for each choice:

| Component | Chosen | Alternatives considered | Why |
|---|---|---|---|
| Postgres | **Neon** | Supabase, Railway, Aiven | Serverless-native (scales to zero, generous free tier), built-in pooler (PgBouncer), branch-per-PR available for future dev workflow |
| Redis | **Upstash** | Redis Cloud, Railway | Free tier includes native Redis protocol (needed for our custom Lua scripts) + TLS, per-request billing above the free cap |
| Backend host | **Render** | Fly.io, Railway, Heroku | First-class Blueprint (IaC), free tier is Node-native (no Docker required), health checks + rolling deploys out of the box |
| Frontend host | **Vercel** | Netlify, Cloudflare Pages | Best-in-class Vite auto-detection, generous free tier, edge caching for the static bundle |

Everything is $0 to run. The only free-tier limitation that matters for this app is Render's cold-start behavior - documented and mitigated (see below).

### Who does what - a mental model

Four services, three totally independent responsibilities. Understanding the split is the key to understanding what a `git push` does and doesn't touch.

| Service | Type | What it stores | What it does on `git push` |
|---|---|---|---|
| **GitHub** | Source of truth | Code, `render.yaml`, `vercel.json` | Receives the push, fires webhooks |
| **Vercel** | Compute (edge / CDN) | Nothing app-specific - just the built static assets | Rebuilds the frontend bundle, uploads to their CDN |
| **Render** | Compute (long-lived Node process) | Nothing - 100% stateless container | Rebuilds the backend, runs migrations, boots the new process, cuts traffic over |
| **Neon** | Postgres storage | All user data (users, appointments, series, schedules) | **Nothing.** DB is untouched. Only the code that talks to it changes. |
| **Upstash** | Redis storage | Ephemeral state (holds, idempotency cache, distributed locks) | **Nothing.** Redis TTLs everything anyway, so it's naturally self-cleaning. |

The two storage services (Neon, Upstash) never see your `git push` - they only receive traffic from the running backend. That's the crux of the "code redeploys, data persists" model.

### Deploy lifecycle - what happens when you `git push`

Concrete second-by-second sequence:

```
t=0     git push origin main
t=1     GitHub receives the commit
t=2     GitHub fires two webhooks in parallel:
        ├─▶ Render:  "wysa-backend repo updated"
        └─▶ Vercel:  "wysa repo updated"
        (Neither service knows about or coordinates with the other.)

──── Render branch (backend) ────
t=5     Render clones the repo at the new commit
t=8     Runs buildCommand from render.yaml:
        npm ci --include=dev              (~40 s - installs deps)
        npm run build                     (~10 s - tsc emits dist/)
        npm prune --omit=dev              (~5 s - strips devDeps)
t=70    Runs startCommand:
        npm run db:migrate:prod           (Drizzle applies any new migrations
                                           to Neon; no-op if already applied)
        npm start                         (node dist/index.js - new process)
t=75    New process binds to :10000, connects to Neon + Upstash,
        schedules the cron, /health returns {"ok":true}
t=76    Render flips the load balancer to the new instance
t=77    Old instance receives SIGTERM → graceful shutdown → exits
        Zero-downtime cutover complete.

──── Vercel branch (frontend) ────
t=5     Vercel clones the repo at the new commit
t=8     Detects vercel.json → runs `vite build` from /frontend
        VITE_API_URL is baked in from Vercel's env var at THIS moment
        (frontend env vars are compile-time, not runtime)
t=35    Uploads the built dist/ folder to Vercel's edge CDN
t=40    Aliases the production URL to the new deployment
        Old deployment stays around indefinitely (rollback-ready)
```

**Both services finish independently in ~1-2 min.** No coordination. If the backend deploy fails, the frontend still deploys - you'll get a working UI that can't talk to the API. Same in reverse. Rare in practice, easy to notice via smoke test.

### What auto-updates vs what doesn't

The single most important table in this doc for day-2 operations.

| Thing you changed | Auto-deploys on `git push`? | Requires manual action |
|---|---|---|
| Backend source code (`backend/src/**`) | ✅ Render rebuilds and rolls out | - |
| Frontend source code (`frontend/src/**`) | ✅ Vercel rebuilds and rolls out | - |
| Backend dependencies (`backend/package.json`) | ✅ Included in `npm ci` on next build | - |
| Frontend dependencies (`frontend/package.json`) | ✅ Included in Vercel's build | - |
| Database **schema** (new Drizzle migration file) | ✅ `db:migrate:prod` runs on every backend boot | - |
| Database **data** (seed changes) | ❌ Seed is never auto-run | Re-run `npm run db:seed` locally against Neon (see below) |
| `render.yaml` (non-secret env vars, build command, region) | ✅ Render re-reads it on each build | - |
| `vercel.json` (rewrites, headers, build settings) | ✅ Vercel re-reads it on each build | - |
| **Secret** env vars (`DATABASE_URL`, `REDIS_URL`, `CORS_ORIGIN`, `ADMIN_TOKEN`, `JWT_SECRET`) | ❌ Never in git | Set once in Render dashboard → Environment tab |
| Frontend env var (`VITE_API_URL`) | ❌ Baked in at build time | Set once in Vercel dashboard → Settings → Environment |
| Neon database itself (provisioning, region, plan) | ❌ | Managed in Neon dashboard |
| Upstash Redis itself | ❌ | Managed in Upstash dashboard |

The two footguns hidden in this table:

1. **Frontend env vars are compile-time.** If you change `VITE_API_URL` in Vercel, nothing happens until the **next** deploy. Trigger a redeploy from the Vercel dashboard (or push a no-op commit) after editing it.
2. **Seed is intentionally not automatic.** Once therapists start editing their schedules through the UI, re-running the seed would silently wipe those edits. If you truly need a re-seed, either accept the loss or write a partial-seed script that only touches missing rows.

### Monorepo caveat - both services rebuild on every push

By default, Render and Vercel each rebuild on **every** push, even one that only touched the other service's folder. So editing a single line in `frontend/src/App.tsx` triggers a backend rebuild too (which is a no-op that still burns 60 seconds).

That's fine for a demo (extra builds are free), but for production I'd add **path filters**:

- Render: set `watchPaths: ["backend/**", "render.yaml"]` in `render.yaml`.
- Vercel: add "Ignored Build Step" script that exits 0 when no `frontend/**` files changed.

Not done here because the extra build noise is invisible and the fix is one line each when you actually need it.

### Boot sequence on the backend (cold start)

Useful to know when debugging "why is the first request slow?":

```
1. Render receives an inbound request to a sleeping instance
2. Container spins up (~10 s - pulling image, starting Node process)
3. node dist/db/migrate.js:
     - Opens a Postgres connection
     - Reads __drizzle_migrations table
     - Applies pending migrations (usually zero)
     - Exits
4. node dist/index.js:
     - Loads config (Zod validates all env vars - fails fast if any missing)
     - Opens Postgres pool (5 connections, TLS)
     - Opens Redis connection (TLS via rediss://)
     - Schedules the nightly cron
     - Binds to :10000
     - Logs "Wysa backend listening"
5. Render's health check hits /health → returns {"ok":true}
6. Load balancer flips traffic to the instance
7. First real request served
```

Total cold start: **~30 s** on Render free tier. **~2 s** on a paid always-on plan (steps 1-3 vanish; only the process needs to start).

### Runtime request flow - one booking, end to end

Sequence when a patient clicks "Confirm booking":

```
1. React makes POST https://wysa-backend.onrender.com/appointments
   with Authorization: Bearer <jwt> and Idempotency-Key: <uuid>
                            │
                            ▼
2. Vercel's CDN passes it through (Vercel only serves the static bundle;
   API calls go direct to Render - same-origin isn't enforced, CORS handles it)
                            │
                            ▼
3. Render load balancer routes to the running instance
                            │
                            ▼
4. Express middleware chain: helmet → cors → pinoHttp (assigns req-id) →
   rateLimit (per-user, checks Redis) → authenticate (verifies JWT) →
   authorize("PATIENT") → validate(body via Zod)
                            │
                            ▼
5. withIdempotency wrapper checks Redis for a cached response under
   idem:<patientId>:<key>. Hit? Return the cached body. Miss? Continue.
                            │
                            ▼
6. Acquire Redlock on booking:<therapistId>:<startTime>
   (Redis SET NX EX across all API instances - mutual exclusion)
                            │
                            ▼
7. Consume the hold atomically (Lua script in Redis)
                            │
                            ▼
8. INSERT appointment (Postgres partial unique index is the final safety net -
   if the Redlock ever failed, the DB would still reject a duplicate)
                            │
                            ▼
9. Cache the response in Redis under the idempotency key (TTL: 24 h)
                            │
                            ▼
10. Release Redlock
                            │
                            ▼
11. Response flows back → React updates UI
```

Every hop is instrumented - check the Render logs and you'll see a single line per request with the req-id, path, status, and response time.

### Re-seeding production data without shell access

Render's free tier doesn't include Shell access, so the seed can't be run inside the container. Two workable paths:

**Preferred - run seed locally against Neon:**
```bash
cd backend
cp .env .env.local.bak
# swap DATABASE_URL to the Neon pooled URL in .env
npm run db:seed
mv .env.local.bak .env
```
Same script, same idempotency guarantees. The seed connects to Neon over TLS just like the deployed backend does - there's nothing "prod" about running from your laptop except the destination URL.

**Alternative - a guarded admin endpoint:** if you plan to re-seed frequently, adding `POST /admin/seed` (guarded by `X-Admin-Token`) is a ~15-line change. Not done today because occasional re-seeds via local shell are simpler and safer than shipping a mutating endpoint.

### Production-readiness changes

#### 1. Postgres TLS auto-detection ([`backend/src/db/index.ts`](./backend/src/db/index.ts))

Neon (and every other managed Postgres worth considering) requires TLS. Instead of a hard-coded `sslmode`, the driver detects the need by URL heuristics + `NODE_ENV`:

```ts
const needsSsl =
  config.NODE_ENV === "production" ||
  url.includes("sslmode=require") ||
  url.includes(".neon.tech") ||
  url.includes(".render.com") ||
  url.includes(".supabase.co") ||
  url.includes(".aws.");
```

`rejectUnauthorized: false` is used to accept the provider's cert without pinning - acceptable for a demo, easily upgradeable to a shipped CA bundle for a hardened deployment. Pool size drops from 10 → 5 in production because Neon's default plan is more sensitive to open connections and the pooled endpoint amplifies fewer connections into many logical ones.

#### 2. Redis TLS ([`backend/src/redis.ts`](./backend/src/redis.ts))

`ioredis` auto-detects TLS from the `rediss://` URL scheme, so nothing structural changes. Added an exponential retry strategy capped at 2 s to survive Upstash's brief cold-connection blips.

#### 3. Graceful shutdown ([`backend/src/index.ts`](./backend/src/index.ts))

Render/PaaS providers send `SIGTERM` and give ~30 seconds before `SIGKILL`. The shutdown handler:

1. Stops accepting new connections (`server.close`), so the health check flips to unhealthy and the load balancer routes traffic away.
2. Lets in-flight requests finish (Express drains automatically).
3. Closes the Redis client.
4. Ends the Postgres pool.
5. Exits 0.

A 15 s force-exit timer guards against a stuck close. Also handles `uncaughtException` and `unhandledRejection` - any promise rejection that escapes the request path now triggers a clean shutdown instead of leaving the process wedged.

Verified locally: booting `node dist/index.js` and sending `SIGTERM` produces:
```
Graceful shutdown starting
HTTP server closed
Redis client closed
Postgres pool ended
```

#### 4. Migration on startup ([`backend/package.json`](./backend/package.json))

Two new prod scripts:
- `db:migrate:prod` → `node dist/db/migrate.js` (no `tsx` dev dep needed)
- `start:prod` → chains migrate + start

Render's start command is `npm run db:migrate:prod && npm start`. Drizzle tracks applied migrations in a `__drizzle_migrations` table, so running on every boot is idempotent + safe.

Seeding is **not** automatic - `db:seed:prod` is available for a one-off shell exec after the first successful deploy. Running it on every deploy would clobber real data as soon as therapists start editing their schedules.

### Deployment artifacts

- **[`render.yaml`](./render.yaml)** - Render Blueprint. Defines the web service, runtime, build/start commands, health check, all non-secret env vars, and marks the four secrets (`DATABASE_URL`, `REDIS_URL`, `CORS_ORIGIN`, `ADMIN_TOKEN`) as `sync: false` so Render prompts for them post-provision.
- **[`backend/Dockerfile`](./backend/Dockerfile)** - Multi-stage build for portability. Not needed for Render (uses native Node runtime) but works on Fly.io / Railway / any container platform. Runs as non-root `wysa` user, includes a `HEALTHCHECK`.
- **[`frontend/vercel.json`](./frontend/vercel.json)** - SPA rewrites (`/(?!assets/).*` → `/index.html`), aggressive caching on `/assets/*` (`max-age=31536000, immutable`), and extra security headers (`X-Frame-Options: DENY`, `Permissions-Policy` denying camera/mic/geolocation).
- **[`DEPLOY.md`](./DEPLOY.md)** - Human-readable step-by-step: Neon → Upstash → Render (Blueprint or manual) → Vercel → verification. Includes a full environment-variable reference table and troubleshooting section.

### Production smoke test

`backend/scripts/smoke-prod.mjs` - 14 read-only assertions across 5 areas: `/health`, `/auth/login`, `/therapists`, `/availability`, `/appointments`. Usage:

```bash
API_URL=https://wysa-backend.onrender.com \
  node backend/scripts/smoke-prod.mjs
```

Prints per-check pass/fail and response times. Verified against local backend: **14/14 passing in ~700 ms end-to-end.**

### Free-tier limitations (documented, not solved)

| Limitation | Impact | Mitigation |
|---|---|---|
| Render free plan sleeps after 15 min idle | ~30 s cold start after inactivity | Upgrade to Starter ($7/mo) OR add an uptime pinger |
| Node-cron doesn't fire when service is asleep | Nightly series extension may miss windows | Replace internal cron with a Render Cron Job (or Vercel Cron / Upstash QStash) hitting `POST /series/extend` with `X-Admin-Token` |
| Neon free tier has an active connection ceiling | Handled by using the pooled endpoint | Pool size lowered to 5 in prod |
| Upstash free tier has a per-day command cap | Rate-limited endpoints keep us well under | Add per-user booking rate limit (already done in Phase 7) |

