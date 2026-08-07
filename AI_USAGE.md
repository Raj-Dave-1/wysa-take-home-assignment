# AI Usage

An honest account of how AI was used to build this take-home. The goal is transparency, not performance — so this covers both where AI accelerated the work and where I caught it being wrong.

---

## Tools

| Tool | Model | Used for |
|---|---|---|
| **Cursor IDE** | Claude Opus 4.7 (Cursor's Sonnet/Opus rotation) | Primary pair — architecture discussions, code generation, review, docs |

No other AI tools (no Copilot, no ChatGPT web) were used for this project — a single tool with full repo context was simpler and produced better results than context-switching.

---

## Workflow

Rather than "one prompt → whole app," the build was **planned as nine phases**, one prompt per phase, with a strict order:

1. **Foundation** — Docker, DB schema, JWT auth
2. **Availability & Holds** — schedule projection, Redis holds
3. **Booking** — idempotency, Redlock, DB unique index
4. **Recurring series** — 90-day materialization + cron extension
5. **Therapist flows** — status updates, schedule editor
6. **Frontend** — Vite/React/Tailwind, patient + therapist dashboards
7. **Hardening** — rate limits, validation, security headers, log redaction
8. **Deployment** — Neon + Upstash + Render + Vercel
9. **Documentation polish** — this file, README, technical journal

For each phase I asked AI to:
1. Restate the goal so I could catch misunderstandings before code was written.
2. Propose a design (data model, endpoints, algorithms), then explain trade-offs.
3. Only then, implement. After each phase, run smoke tests I designed with it, and update [`TECHNICALS.md`](./TECHNICALS.md) with decisions.

This slow-down-to-speed-up pattern is what made a 9-phase build tractable in a small number of sessions.

---

## What AI contributed materially

**Architecture pieces where AI's suggestion was better than my starting point:**

- **Anchor-relative occurrence enumeration for recurring series.** I initially thought "just add 7 days N times" for weekly. AI pushed back: months don't have 4 weeks, DST shifts move wall-clock times, and repeated date arithmetic drifts. The [`enumerateOccurrences`](./backend/src/series/frequency.ts) function calculates each occurrence *relative to the original anchor* instead of chaining `+7 days` — which sidesteps the entire class of DST + month-length bugs. I would not have thought of framing it that way.

- **Partial unique index as the third correctness layer.** Redis holds + Redlock feels sufficient. The suggestion to add `CREATE UNIQUE INDEX ... ON appointments (therapist_id, start_time) WHERE status <> 'cancelled'` as the **last-line defense** — so even a code bug or a hand-rolled `INSERT` can't create a double-booking — is the kind of belt-and-suspenders thinking I wanted an AI pair for.

- **Custom Lua scripts for atomic hold operations** ([`redis.ts`](./backend/src/redis.ts)). My first cut was several `SETNX` + `SET` calls, which is not atomic. AI proposed bundling them into `acquireHold` / `releaseHold` / `consumeHold` Lua scripts so the checks and mutations happen inside a single Redis round-trip. Two-line change in the calling code, but it eliminates a whole class of race conditions.

- **Server-side hold reverse-index** (`patient:hold:{patientId}`). To support "one hold per patient at a time" and refresh-survival for the countdown UI, we needed to answer "what hold does this patient have?" in O(1). AI proposed storing a reverse key with matching TTL, so we can query holds by patient without scanning `hold:*`. Small idea, big UX impact.

**Code-level places AI produced quickly what would have been tedious for me:**

- The three-tier rate-limit factory in [`lib/rateLimit.ts`](./backend/src/lib/rateLimit.ts).
- Every zod schema (bodies, queries, params) — mechanical work AI does perfectly.
- The pino redaction paths — AI knew the dotted-path syntax I would have had to look up.
- Tailwind class incantations for the calming-teal design language.
- The `render.yaml` Blueprint with correct env-var flags (`generateValue` vs `sync: false`).

---

## Where AI got it wrong (specific, with fixes)

Being explicit here matters more than the shiny wins:

### 1. Frontend/backend date format mismatch (Phase 6b)

AI generated a frontend availability query that sent `from` and `to` as full ISO 8601 timestamps. The backend's Zod schema (which AI had *also* written in Phase 2) required `YYYY-MM-DD`. Result: every request returned a 400, but the UI silently rendered the "no slots available" empty state.

**How I caught it:** I ran a headless-Chrome screenshot of the patient dashboard after Phase 6b and saw the empty state where I expected a slot grid.

**Fix:** Two-part — send `YYYY-MM-DD` from the frontend hooks *and* surface `useQuery` errors in the UI so silent 400s become impossible. Fixed in [`AvailabilityView.tsx`](./frontend/src/features/patient/AvailabilityView.tsx).

**Lesson:** AI is great at generating each side of an integration, but doesn't cross-check that the *contract* matches when the two sides are written in different sessions. Screenshots caught what typechecks couldn't.

### 2. Wrong `express-rate-limit` API (Phase 7)

AI wrote `import { ipKeyGenerator } from "express-rate-limit"` — that named export exists in v8-beta but not in v7.5 (which is what our lockfile pinned). TypeScript caught this at build time.

**Fix:** Removed the named import and relied on the library's default IP-based `keyGenerator`. Fixed in [`lib/rateLimit.ts`](./backend/src/lib/rateLimit.ts).

**Lesson:** AI's package API knowledge can lag the actual installed version. Always let `tsc --noEmit` be the final arbiter.

### 3. TSConfig project-reference confusion (Phase 6a)

AI's initial Vite/TS config used `references` with a separate `tsconfig.node.json` and `noEmit: true` — which `tsc -b` rejects (referenced projects can't disable emit). Two rounds of iteration to arrive at a single-tsconfig setup that just works.

**Lesson:** TS's build modes are a maze; the simpler solution (one tsconfig) was correct.

### 4. Phase 4 smoke test scenario was self-blocking

AI wrote a scenario where Patient B tries to book a weekly series where one occurrence conflicts with Patient A's existing weekly series. But because Patient A's series was fully booked, Patient B's *first* attempt (acquiring a hold) failed with 410 GONE before ever reaching the series-conflict pre-check we wanted to exercise.

**How I caught it:** Ran the smoke test, saw a 410 where I expected a 409. Understood the interaction chain and asked AI to rewrite the scenario.

**Fix:** Patient B books a *one-time* appointment on a future date first; then Patient A attempts a weekly series that includes that date. Now the pre-check fires with the intended `SERIES_CONFLICT` error and structured `details`.

**Lesson:** AI can generate a "test that verifies X" without checking whether the setup actually reaches the code path X lives in. Reading the test output line by line matters.

### 5. Auto-review restrictions on destructive commands

Not really an "AI error," but worth documenting: several times, cleanup commands (`docker exec ... FLUSHDB`, kill-and-restart flows) were blocked by Cursor's auto-review. I approved them explicitly when appropriate. The workflow taught me to structure tests so DB resets are self-contained and obvious in intent.

---

## Real prompts I used (verbatim)

The full transcript is preserved in Cursor's agent history; these are representative of the ~9 prompts that ran the whole build.

### Prompt 1 — kickoff

```
this is the task: I'm applying for this role: Associate Full Stack Engineer 
Job Description | July 2026 ...

Help me finish this task, break this down into technical, system design, and 
deployment part, give kind of a roadmap and help me finish it :

Associate Full-Stack Engineer: Take-Home Assignment

Objective: Build an appointment booking system where patients can temporarily 
hold and book appointment slots with a Therapist. The system should support 
recurring appointments with multiple recurrence frequencies.

[full assignment pasted]

Help me finish this. I want to build it in phases. this is the phase 1 
solution: [pasted my initial plan for stack + schema]
```

This one prompt produced the 9-phase roadmap and the entire tech-stack rationale. Everything downstream was scoped in that first design conversation.

### Prompt 2 — Phase 3 with journaling instruction

```
Yes Please Start Phase 3 and also Keep maintaining a new document 
Tehcnicals.MD and put all decision, technial things, algorithms etc there.
```

This is when [`TECHNICALS.md`](./TECHNICALS.md) was born. Making decisions permanent (in a file, not in chat history) is what let me review the design at any point without re-asking. Each subsequent phase updated that file.

### Prompt 3 — Phase 7

```
yes, let's start with Phase 7
```

Short but loaded — by this point the AI had all the context it needed. The prompt kicked off a full audit of the middleware pipeline, produced a gap list, and implemented the fixes in one focused session. The value wasn't in the prompt, it was in the accumulated context.

### Prompt 4 — deployment

```
Let's start with Phase-8
```

Same pattern — Phase 8 produced the Render Blueprint, Dockerfile, Vercel config, prod smoke script, and [`DEPLOY.md`](./DEPLOY.md) walkthrough without a single follow-up. The phased structure paid off here.

### Prompt 5 — Phase 4 test scenario correction (mid-phase)

_(paraphrased from the diff to the smoke test — the actual exchange was small)_

```
The Phase 4 test scenario for "Patient B series conflicts with Patient A's 
series" is failing with a 410 instead of the 409 SERIES_CONFLICT I want to 
verify. Trace through what's happening — I think Patient B can't even get 
a hold because Patient A's series has already booked all the slots.
```

This is what I mean by "reading the test output line by line." Naming the exact hypothesis was more efficient than "the test fails, fix it."

---

## Ground rules I followed

- **Never merge AI code I don't understand.** Every diff got read before it was accepted. The [correctness section of the README](./README.md#the-interesting-part-correctness-under-concurrency) exists because I actually understand each of the three layers, not because AI told me they were "important."
- **Screenshots > vibes.** I generated a headless-Chrome screenshot after every UI phase and looked at the pixels. That's how the date-format bug was caught.
- **Smoke tests before commit.** Every phase has a smoke script that I read the output of. Green ≠ correct; I still verified the assertions were meaningful (see Phase 4 scenario correction above).
- **Typecheck + lint on every save.** Cheap safety net that caught the `ipKeyGenerator` import error before it hit runtime.
- **AI wrote no user-facing decisions.** Feature scope, data model boundaries, phase ordering, trade-off calls — those were mine. AI implemented and pressure-tested my choices.

---

## Overall assessment

Without AI, this build would have taken me 3–4 full days end-to-end. With AI (Cursor + Claude Opus 4.7), it took about 8 hours of focused work spread across a couple of sessions. The multiplier isn't uniform — AI helped ~10× on boilerplate (schemas, tailwind, config files), ~3× on algorithmic decisions (recurring series, hold semantics, error handling patterns), and roughly ~1× on integration + debugging (I had to actually run and read output either way).

Most importantly, AI does not replace the requirement to **understand the system I'm shipping**. The concurrency story, the three-layer defense, the trade-off between per-user and per-IP rate limits — those exist in my head because I made them explicit in [`TECHNICALS.md`](./TECHNICALS.md) as I went. If a reviewer asks me *why* the partial unique index has `WHERE status <> 'cancelled'` and not just `(therapist_id, start_time)`, I can answer without re-reading anything.
