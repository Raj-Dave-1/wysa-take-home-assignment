# Deployment Guide

Four managed services, one afternoon.

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

**Total cost on free tiers:** $0. **Estimated time:** 30 minutes.

---

## 0. Prerequisites

- The repo pushed to GitHub (Render + Vercel both integrate via Git).
- Accounts on: [Neon](https://neon.tech), [Upstash](https://upstash.com), [Render](https://render.com), [Vercel](https://vercel.com).

---

## 1. Neon — Postgres

1. Create a new project (region: pick closest to your Render region, e.g. Singapore).
2. Neon gives you a default `neondb` database — that's fine, or create `wysa`.
3. From the project dashboard, copy the **pooled** connection string (looks like `postgres://user:password@ep-xxx-pooler.region.aws.neon.tech/neondb?sslmode=require`). The `-pooler` variant is important — it lets you burst above the direct-connection limit.
4. Save it — you'll paste it into Render as `DATABASE_URL`.

_Migrations run automatically on backend startup (`db:migrate:prod`), so no manual setup here._

---

## 2. Upstash — Redis

1. Create a new Redis database. Region: same as Render.
2. Enable **TLS** (default on the free tier). Do **not** pick the "REST-only" option — the app uses custom Lua scripts, which require the Redis protocol.
3. From the database page, copy the **Redis URL** (starts with `rediss://` — the extra `s` = TLS).
4. Save it for Render as `REDIS_URL`.

---

## 3. Render — Backend

You have two options: **Blueprint** (one-click, uses [`render.yaml`](./render.yaml)) or **manual**.

### Option A — Blueprint (recommended)

1. Render dashboard → **New +** → **Blueprint**.
2. Connect your GitHub repo. Render picks up `render.yaml` at the root.
3. Render creates the `wysa-backend` service with all non-secret env vars pre-filled and `JWT_SECRET` auto-generated.
4. In the service's **Environment** tab, fill in the four secrets:
   - `DATABASE_URL` — the Neon pooled URL from step 1.
   - `REDIS_URL` — the Upstash `rediss://…` URL from step 2.
   - `CORS_ORIGIN` — paste your Vercel URL after step 4 (comma-separated for multiple, e.g. `https://wysa.vercel.app,https://wysa-preview.vercel.app`). For the first deploy you can put `*` temporarily and lock it down after Vercel is set up.
   - `ADMIN_TOKEN` — a random 32+ char string (or leave blank until you need `/series/extend` locked down).
5. Trigger a deploy. First boot takes ~2 minutes (npm install → build → migrate → start).
6. Health check: hit `https://<your-service>.onrender.com/health` — should return `{"ok":true,...}`.
7. Seed the demo users (one-time, from the Render dashboard → **Shell** on the service):
   ```
   node dist/db/seed.js
   ```

### Option B — Manual

- Create a **Web Service** → Node runtime, root dir `backend/`.
- Build command: `npm ci --include=dev && npm run build && npm prune --omit=dev`
  _(Render sets `NODE_ENV=production` before install, which would otherwise skip TypeScript + `@types/*`. Include-dev for the build, prune after.)_
- Start command: `npm run db:migrate:prod && npm start`
- Health check path: `/health`
- Copy all env vars from [`render.yaml`](./render.yaml) → Environment tab.
- Same secret + seed steps as Option A.

### Notes on the Render free tier

- **Cold starts** — the free plan spins the service down after ~15 min of inactivity. First request after a cold start takes ~30 s (Node + DB pool warmup). Fine for a demo; upgrade to Starter ($7/mo) for zero-idle.
- **Cron reliability** — [`node-cron`](./backend/src/series/cron.ts) runs series extension nightly at 02:00 in the process timezone. This won't fire if the service is sleeping. Two easy fixes:
  1. Upgrade to a paid plan (always-on).
  2. Add a Render Cron Job that hits `POST /series/extend` daily with the `X-Admin-Token` header (the internal cron becomes a no-op via Redlock).

---

## 4. Vercel — Frontend

1. Vercel dashboard → **Add New** → **Project** → import the repo.
2. Set **Root Directory** to `frontend/`. Vercel auto-detects Vite via [`vercel.json`](./frontend/vercel.json).
3. Add one env var:
   - `VITE_API_URL` = `https://<your-render-service>.onrender.com`
4. Deploy. Vercel gives you `https://<project>.vercel.app`.
5. Go back to Render → **Environment** → update `CORS_ORIGIN` to that Vercel URL, save (triggers a rolling redeploy).

---

## 5. Verify end-to-end

```bash
# From your laptop:
API_URL=https://<your-render-service>.onrender.com \
  node backend/scripts/smoke-prod.mjs
```

This runs 14 read-only checks against the live backend — health, login, therapists, availability, appointments — with response-time timings. All checks should pass.

Then open your Vercel URL, log in with any seeded demo account, and walk through: pick therapist → hold a slot → confirm booking (one-time and recurring) → view "My bookings" → cancel. Switch to the therapist login and confirm the appointment shows up in "Your caseload".

---

## Environment variable reference

### Backend (`backend/.env` for local, Render Environment tab for prod)

| Var | Required | Prod value example | Notes |
|---|---|---|---|
| `NODE_ENV` | ✓ | `production` | Enables SSL for Neon, disables dev error details |
| `PORT` | ✓ | `10000` | Render sets this itself; use as-is |
| `DATABASE_URL` | ✓ | `postgres://…@…neon.tech/…?sslmode=require` | Use the **pooled** endpoint |
| `REDIS_URL` | ✓ | `rediss://default:PASS@host.upstash.io:6379` | TLS via `rediss://` |
| `JWT_SECRET` | ✓ | 32+ random chars | `generateValue: true` in Blueprint |
| `JWT_EXPIRES_IN` |   | `7d` | Access token lifetime |
| `JWT_ISSUER` |   | `wysa-api` | Verified on every request |
| `JWT_AUDIENCE` |   | `wysa-clients` | Verified on every request |
| `CORS_ORIGIN` | ✓ | `https://wysa.vercel.app` | Comma-separated list allowed |
| `TRUST_PROXY` |   | `1` | Required for correct rate-limit keying behind Render |
| `HOLD_TTL_SECONDS` |   | `60` | Slot hold lifetime |
| `RECURRING_HORIZON_DAYS` |   | `90` | Series materialization window |
| `APP_TIMEZONE` |   | `Asia/Kolkata` | Assignment's shared TZ |
| `AVAILABILITY_MAX_DAYS` |   | `30` | Max range for a single query |
| `RATE_LIMIT_GLOBAL_PER_MIN` |   | `300` | |
| `RATE_LIMIT_AUTH_PER_MIN` |   | `10` | Brute-force ceiling on `/auth/login` |
| `RATE_LIMIT_BOOKING_PER_MIN` |   | `30` | Per-user, on booking + hold endpoints |
| `ADMIN_TOKEN` |   | 32+ random chars | Required as `X-Admin-Token` on `/series/extend` |

### Frontend (`frontend/.env.production` or Vercel Environment)

| Var | Required | Prod value |
|---|---|---|
| `VITE_API_URL` | ✓ | `https://<render-service>.onrender.com` |

---

## Troubleshooting

**`/health` returns 502** — cold start, wait 30 s. If it persists, check Render logs for connection errors (usually `DATABASE_URL` or `REDIS_URL` typo).

**CORS errors in the browser** — `CORS_ORIGIN` on Render doesn't match your Vercel URL exactly. It must be an exact origin match, not a wildcard subdomain.

**Login works but everything else 401s** — token has `iss`/`aud` claims. If you rotated `JWT_ISSUER` or `JWT_AUDIENCE`, users need to re-login.

**Build fails with `TS7016: Could not find a declaration file for module '…'`** — Render sets `NODE_ENV=production` before `npm ci` runs, so devDependencies (including `typescript` and all `@types/*`) get skipped. Build command must be `npm ci --include=dev && npm run build && npm prune --omit=dev` — install-with-dev, build, prune back. Already set in [`render.yaml`](./render.yaml).

**Migrations fail on first deploy** — the pooled Neon URL sometimes rejects the initial CREATE TABLE burst. Switch to the direct (`-pooler` removed) URL temporarily just for the first migration, then switch back.

**Redis "READONLY" or NOSCRIPT errors** — you picked Upstash's REST-only tier. Recreate as a standard Redis database (protocol-native).

**Cron doesn't run** — expected on the free tier; see the note under "Render free tier".
