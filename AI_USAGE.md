# AI Usage

An honest account of how AI helped me build this. The point isn't to justify anything - it's to be specific about what I asked, what I got, and what I had to fix.

## AI tools used

Just one: **Cursor IDE with Claude Opus 4.7** as the agent model. No Copilot, no ChatGPT tab, nothing else. Keeping to a single tool with full repo context made the sessions much more productive than context-switching, and it also made this document easier to write honestly (I can point to a specific conversation, not a general "I probably used AI somewhere").

## How I worked with it

I planned the build as nine phases up front - foundation, availability + holds, one-time booking, recurring series, therapist flows, frontend, hardening, deployment, docs - and drove each phase as a separate session. For each phase I'd:

1. Ask the AI to restate the goal in its own words, so I could catch misunderstandings before any code got written.
2. Ask for a design (data model, endpoints, algorithms) with trade-offs before implementation.
3. Only then let it write code, and read every diff.

This is slower than "one giant prompt, review at the end," but it's the reason `TECHNICALS.md` reads like a coherent journal rather than a wall of after-the-fact rationalization - I wrote decisions down as they were made.

## Three exact prompts (verbatim from my chat)

These aren't cherry-picked. They're the actual prompts that ran the first, middle, and last major phases of the build.

**Prompt 1 - kickoff:**

```
this is the task: I'm applying for this role: Associate Full Stack Engineer 
Job Description | July 2026 ...

Help me finish this task, break this down into technical, system design, and 
deployment part, give kind of a roadmap and help me finish it :

[full assignment pasted]

Help me finish this. I want to build it in phases. this is the phase 1 
solution: [pasted my initial plan for stack + schema]
```

This one prompt produced the nine-phase roadmap and the whole tech-stack rationale. Everything downstream was scoped in this design conversation. Worth noting: I came in with an opinion (Node + Express + Postgres + Redis) - the AI didn't invent the stack, it pressure-tested it.

**Prompt 2 - Phase 3 with the "keep a journal" instruction:**

```
Yes Please Start Phase 3 and also Keep maintaining a new document 
Tehcnicals.MD and put all decision, technial things, algorithms etc there.
```

This is when `TECHNICALS.md` was born. Forcing decisions into a file (instead of leaving them in chat history) is what kept me from re-litigating the same design questions later. Every subsequent phase updated that file.

**Prompt 3 - Phase 4 test scenario correction (mid-implementation):**

```
The Phase 4 test scenario for "Patient B series conflicts with Patient A's 
series" is failing with a 410 instead of the 409 SERIES_CONFLICT I want to 
verify. Trace through what's happening - I think Patient B can't even get 
a hold because Patient A's series has already booked all the slots.
```

I include this one because it's the kind of prompt that only works after a lot of shared context. Naming the exact hypothesis ("I think X is happening because Y") produced a targeted fix in one round. Saying "the test fails, fix it" would have led to a bunch of guessing.

## Technical decisions where AI shaped my thinking

Not everything was mine, and not everything was AI's. The ones where its suggestion genuinely changed the design:

- **Anchor-relative occurrence enumeration for recurring series.** I originally thought "add 7 days N times" for weekly. The AI pointed out that months don't have 4 weeks, DST shifts break wall-clock times, and repeated additions drift. `enumerateOccurrences` in `backend/src/series/frequency.ts` computes each occurrence *relative to the original anchor* instead of chaining `+7 days`. I would not have thought of it that way.

- **Partial unique index as the last line of defense.** Redis holds + Redlock felt sufficient to me. The suggestion to also add `CREATE UNIQUE INDEX ... ON appointments (therapist_id, start_time) WHERE status <> 'cancelled'` - so even a code bug can't create a double-booking - is exactly the belt-and-suspenders instinct I wanted from a pair.

- **Custom Lua scripts for hold operations.** My first pass at hold acquisition was a couple of `SETNX` and `SET` calls, which isn't atomic across the two. Bundling them into `acquireHold` / `releaseHold` / `consumeHold` Lua scripts (one Redis roundtrip, atomic) eliminated a whole category of race conditions.

- **Server-side hold reverse-index** (`patient:hold:{patientId}`). To make "resume the countdown after a refresh" work and enforce "one hold per patient," we needed O(1) lookup by patient. Storing a reverse key with a matching TTL was a small idea with a big UX payoff.

On top of that, AI handled the parts that were tedious rather than interesting - Zod schemas, Tailwind class incantations, pino redaction paths, the `render.yaml` Blueprint with correct env-var flags, the three-tier rate-limit factory. That's the "10× on boilerplate" part everyone talks about, and it's real.

## Trade-offs I made explicitly

- **Smoke tests over unit tests.** For a system whose whole point is cross-service correctness (Redis + Postgres + HTTP + time), unit tests against mocks would prove nothing. I invested in five phase-scoped smoke scripts instead. Trade-off: no fine-grained regression signal, but very high confidence that the actual system works.
- **Node-cron over a real job scheduler.** Simpler, one dependency, guarded by Redlock so it doesn't double-run across replicas. Trade-off: won't fire when the Render free-tier service is sleeping. Documented, with a mitigation path (Render Cron Job + `X-Admin-Token`) in `DEPLOY.md`.
- **JWT access tokens with no refresh flow.** Fine for a demo. A real system would want short-lived access tokens + a rotating refresh token.
- **Availability computed on every request instead of cached.** For one therapist over a 7-day horizon, that's a handful of DB rows and a Redis MGET - negligible. At scale I'd cache the projection with a short TTL, invalidated on booking/hold events.
- **One shared timezone (`APP_TIMEZONE`) instead of per-user.** The assignment allowed this. Multi-timezone would require per-user TZ + projecting availability in the therapist's TZ.

## Where AI got it wrong - and what I did about it

Being specific here matters more than the wins.

**Frontend/backend date-format mismatch.** The AI generated the frontend availability query to send full ISO 8601 timestamps, but the backend Zod schema (which it had *also* written, in an earlier session) required `YYYY-MM-DD`. Every request returned 400, but the UI silently rendered the empty state. I caught it by taking a headless-Chrome screenshot after the frontend phase and seeing "no slots" where I expected a grid. The fix was two-part: send the right format from the frontend hooks *and* surface `useQuery` errors in the UI so silent 400s become impossible.

The larger point: AI is good at generating each side of an integration but doesn't cross-check that the contracts match when the two sides are written in different sessions. Screenshots caught what typechecks couldn't.

**Wrong `express-rate-limit` API.** The AI wrote `import { ipKeyGenerator } from "express-rate-limit"`. That named export exists in v8-beta but not in v7.5, which is what our lockfile pinned. TypeScript caught it immediately. Fix: rely on the library's default IP-based key generator. Lesson I'd already suspected: AI's package-API knowledge can lag the actual installed version, so `tsc --noEmit` is the final arbiter.

**Phase 4 smoke test that couldn't reach its assertion.** The AI wrote a scenario where Patient B tries to book a weekly series that conflicts with Patient A's existing series. Because Patient A's series had already booked every candidate slot, Patient B's *first* step (acquiring a hold) failed with 410 GONE - before the code ever reached the series-conflict pre-check the test was supposed to verify. I noticed the wrong status code in the output and re-designed the scenario (Patient B books a single one-time appointment on a future date; then Patient A attempts a weekly series that hits that date). Now the pre-check fires with the intended `SERIES_CONFLICT` error.

The lesson from this one is important: AI can generate a "test that verifies X" without confirming the setup actually reaches the code path X lives in. Green ≠ correct - I still had to read the output.

## Suggestions I rejected

- **Full RBAC with an `ADMIN` role and an admin dashboard.** Suggested during the auth phase. I said no - the assignment has two roles, and adding a third with its own UI would have been scope creep for zero credit. The `ADMIN_TOKEN` shared secret guarding `/series/extend` is the appropriate weight of "admin" for this app.
- **Refresh tokens.** Suggested during Phase 7 hardening. Same reasoning - nice for production, wrong effort/reward for a demo whose whole auth surface is one login screen.
- **A retry-with-exponential-backoff wrapper on the frontend fetch client.** React Query already retries on failure; adding another layer would double-retry and blur the error semantics. Left as-is.
- **Custom Postgres CHECK constraints for time ranges on schedules.** I preferred to enforce this in the service layer (with clear error messages) rather than at the DB (with generic constraint-violation messages that would then need translation). Both valid; I chose readability over defense-in-depth here.
- **Pre-generated availability tables** (materialize every slot for every therapist for the next N days into its own table). The AI raised this as a scaling option. I said no - dynamic projection is simpler, easier to reason about, and the assignment doesn't need the scale. Would revisit at real load.

## Ground rules

Two rules I kept, that are the reason I trust the resulting code:

1. **Never merge a diff I don't understand.** Not "skimmed" - actually understand. If I couldn't explain why a piece of code was there, I asked before accepting.
2. **The system, not just the tests, must run.** After every phase I logged into the running app and did the flow by hand. The date-format bug was caught this way; if I'd trusted the smoke tests alone I would have shipped a broken UI.

If a reviewer asks me *why* the partial unique index has `WHERE status <> 'cancelled'` instead of just `(therapist_id, start_time)`, I can answer. That's the bar I set for using AI on production-adjacent code.
