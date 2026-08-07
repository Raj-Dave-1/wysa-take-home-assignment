import { and, asc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { appointments, recurringSeries, schedules } from "../db/schema.js";
import { redis, RedisKeys } from "../redis.js";
import { BadRequest, Conflict, Forbidden, Gone, NotFound } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { APP_TZ, combineDateAndTimeInAppTz, dayjs } from "../lib/time.js";
import { config } from "../config.js";
import {
  enumerateOccurrences,
  type Frequency,
  type Occurrence,
} from "./frequency.js";

export interface SeriesRow {
  id: string;
  patientId: string;
  therapistId: string;
  frequency: Frequency;
  anchorStart: string;
  anchorEnd: string;
  endDate: string | null;
  materializedThrough: string | null;
  active: boolean;
  createdAt: string;
}

function toSeriesRow(s: typeof recurringSeries.$inferSelect): SeriesRow {
  return {
    id: s.id,
    patientId: s.patientId,
    therapistId: s.therapistId,
    frequency: s.frequency as Frequency,
    anchorStart: s.anchorStart.toISOString(),
    anchorEnd: s.anchorEnd.toISOString(),
    endDate: s.endDate ? s.endDate.toISOString() : null,
    materializedThrough: s.materializedThrough
      ? s.materializedThrough.toISOString()
      : null,
    active: s.active,
    createdAt: s.createdAt.toISOString(),
  };
}

interface ScheduleWindow {
  dayOfWeek: number;
  startTimeStr: string; // HH:mm
  endTimeStr: string;
}

async function loadScheduleWindows(
  therapistId: string
): Promise<ScheduleWindow[]> {
  const rows = await db
    .select()
    .from(schedules)
    .where(eq(schedules.therapistId, therapistId));
  return rows.map((r) => ({
    dayOfWeek: r.dayOfWeek,
    startTimeStr: r.startTime.slice(0, 5),
    endTimeStr: r.endTime.slice(0, 5),
  }));
}

/**
 * Does this occurrence align with any of the therapist's weekly schedule
 * windows (day-of-week + exact start/end time-of-day in APP_TZ)?
 */
function occurrenceMatchesSchedule(
  occ: Occurrence,
  windows: ScheduleWindow[]
): boolean {
  const startInTz = dayjs.tz(occ.start, APP_TZ);
  const dayISO = startInTz.format("YYYY-MM-DD");
  const dow = startInTz.day();
  const candidateStart = occ.start.getTime();
  const candidateEnd = occ.end.getTime();
  return windows.some((w) => {
    if (w.dayOfWeek !== dow) return false;
    const s = combineDateAndTimeInAppTz(dayISO, w.startTimeStr).getTime();
    const e = combineDateAndTimeInAppTz(dayISO, w.endTimeStr).getTime();
    return s === candidateStart && e === candidateEnd;
  });
}

/**
 * Batched conflict check across DB (booked) + Redis (held by someone else).
 * Returns the ISO start times that conflict (empty array = green light).
 */
async function findConflicts(params: {
  therapistId: string;
  patientId: string;
  occurrences: Occurrence[];
}): Promise<string[]> {
  const { therapistId, patientId, occurrences } = params;
  if (occurrences.length === 0) return [];

  const startDates = occurrences.map((o) => o.start);
  const startISOs = occurrences.map((o) => o.start.toISOString());

  const [booked, holdValues] = await Promise.all([
    db
      .select({ startTime: appointments.startTime })
      .from(appointments)
      .where(
        and(
          eq(appointments.therapistId, therapistId),
          inArray(appointments.startTime, startDates),
          ne(appointments.status, "cancelled")
        )
      ),
    redis.mget(
      ...startISOs.map((iso) => RedisKeys.hold(therapistId, iso))
    ),
  ]);

  const bookedSet = new Set(
    booked.map((r) => new Date(r.startTime).toISOString())
  );
  const conflicts: string[] = [];

  for (let i = 0; i < startISOs.length; i++) {
    const iso = startISOs[i];
    if (bookedSet.has(iso)) {
      conflicts.push(iso);
      continue;
    }
    const holder = holdValues[i];
    if (holder && holder !== patientId) {
      conflicts.push(iso);
    }
  }
  return conflicts;
}

export interface SeriesBookingResult {
  series: SeriesRow;
  appointments: (typeof appointments.$inferSelect)[];
  skipped: number;
  horizonEnd: string;
}

/**
 * Book a recurring series. Requires the caller to already hold the anchor slot.
 *
 * Correctness stack:
 *  1. Require an active hold on the anchor (Phase 2 acquired it; we verify + consume here).
 *  2. Enumerate occurrences up to the rolling horizon (or endDate, whichever comes first).
 *  3. Skip occurrences that don't align with the therapist's schedule (daily/monthly may drift off).
 *  4. Batched pre-check for conflicts (DB + Redis) → 409 with the offending times if any.
 *  5. Single DB transaction: INSERT series + N appointments. Unique index catches any race
 *     that slipped past pre-check → rollback → 409.
 *  6. Best-effort consume the anchor hold (harmless if it fails — TTL cleans up).
 */
export async function bookRecurringSeries(params: {
  patientId: string;
  therapistId: string;
  anchorStart: Date;
  anchorEnd: Date;
  frequency: Frequency;
  endDate?: Date;
}): Promise<SeriesBookingResult> {
  const { patientId, therapistId, anchorStart, anchorEnd, frequency, endDate } =
    params;

  if (anchorEnd <= anchorStart) throw BadRequest("End must be after start");
  if (anchorStart <= new Date()) throw BadRequest("Anchor is in the past");
  if (endDate && endDate <= anchorStart) {
    throw BadRequest("endDate must be after anchor start");
  }

  const anchorISO = anchorStart.toISOString();
  const anchorSlotKey = RedisKeys.hold(therapistId, anchorISO);
  const anchorPatientKey = RedisKeys.patientHold(patientId);

  // Layer 1: verify anchor hold exists AND is ours (peek — don't consume yet).
  const owner = await redis.get(anchorSlotKey);
  if (owner !== patientId) {
    throw Gone("Anchor hold expired or you do not own this hold");
  }

  // Compute horizon: min(now + N days, endDate).
  const horizonFromNow = dayjs()
    .add(config.RECURRING_HORIZON_DAYS, "day")
    .toDate();
  const horizonEnd =
    endDate && endDate < horizonFromNow ? endDate : horizonFromNow;

  const allOccurrences = enumerateOccurrences(
    anchorStart,
    anchorEnd,
    frequency,
    horizonEnd
  );

  const scheduleWindows = await loadScheduleWindows(therapistId);
  const validOccurrences = allOccurrences.filter((o) =>
    occurrenceMatchesSchedule(o, scheduleWindows)
  );
  const skipped = allOccurrences.length - validOccurrences.length;

  if (validOccurrences.length === 0) {
    throw BadRequest(
      "No valid occurrences within horizon — check schedule and frequency"
    );
  }

  // The anchor itself must still be in the list — if not, the whole series is invalid.
  const hasAnchor = validOccurrences.some(
    (o) => o.start.getTime() === anchorStart.getTime()
  );
  if (!hasAnchor) {
    throw BadRequest("Anchor slot does not match a schedule window");
  }

  // Layer 2: conflict pre-check.
  const conflicts = await findConflicts({
    therapistId,
    patientId,
    occurrences: validOccurrences,
  });
  if (conflicts.length > 0) {
    throw new (class extends Error {
      status = 409;
      code = "SERIES_CONFLICT";
      details: { conflicts: string[] };
      constructor(conflicts: string[]) {
        super("Series conflicts with existing bookings");
        this.details = { conflicts };
      }
    })(conflicts) as unknown as Error;
  }

  // Layer 3: transactional insert. If unique index fires on any row → rollback → 409.
  let seriesRow!: typeof recurringSeries.$inferSelect;
  let insertedAppointments!: (typeof appointments.$inferSelect)[];
  try {
    await db.transaction(async (tx) => {
      const [s] = await tx
        .insert(recurringSeries)
        .values({
          patientId,
          therapistId,
          frequency,
          anchorStart,
          anchorEnd,
          endDate: endDate ?? null,
          materializedThrough: horizonEnd,
          active: true,
        })
        .returning();
      seriesRow = s;

      insertedAppointments = await tx
        .insert(appointments)
        .values(
          validOccurrences.map((occ) => ({
            patientId,
            therapistId,
            startTime: occ.start,
            endTime: occ.end,
            status: "scheduled" as const,
            seriesId: s.id,
          }))
        )
        .returning();
    });
  } catch (err: unknown) {
    const pgErr = err as { code?: string };
    if (pgErr?.code === "23505") {
      throw Conflict("Series conflicts with existing bookings (race)");
    }
    throw err;
  }

  // Best-effort: consume the anchor hold so /holds/mine clears immediately.
  try {
    await redis.consumeHold(anchorSlotKey, anchorPatientKey, patientId);
  } catch (err) {
    logger.warn({ err }, "Anchor hold consume post-series-book failed (harmless)");
  }

  return {
    series: toSeriesRow(seriesRow),
    appointments: insertedAppointments,
    skipped,
    horizonEnd: horizonEnd.toISOString(),
  };
}

export async function listPatientSeries(patientId: string): Promise<SeriesRow[]> {
  const rows = await db
    .select()
    .from(recurringSeries)
    .where(eq(recurringSeries.patientId, patientId))
    .orderBy(asc(recurringSeries.anchorStart));
  return rows.map(toSeriesRow);
}

/**
 * Cancel every future non-cancelled appointment in the series and mark the
 * series inactive so the cron won't extend it.
 */
export async function cancelSeries(params: {
  patientId: string;
  seriesId: string;
}) {
  const { patientId, seriesId } = params;

  const [existing] = await db
    .select()
    .from(recurringSeries)
    .where(eq(recurringSeries.id, seriesId))
    .limit(1);
  if (!existing) throw NotFound("Series not found");
  if (existing.patientId !== patientId) throw Forbidden();

  const now = new Date();

  const cancelled = await db
    .update(appointments)
    .set({ status: "cancelled", updatedAt: now })
    .where(
      and(
        eq(appointments.seriesId, seriesId),
        gte(appointments.startTime, now),
        ne(appointments.status, "cancelled"),
        ne(appointments.status, "completed"),
        ne(appointments.status, "no_show")
      )
    )
    .returning({ id: appointments.id });

  await db
    .update(recurringSeries)
    .set({ active: false })
    .where(eq(recurringSeries.id, seriesId));

  return {
    seriesId,
    cancelledCount: cancelled.length,
  };
}

/**
 * Cron / manual: for every active series whose materialization is behind the
 * horizon, generate + insert the missing occurrences. Idempotent because the
 * unique index prevents duplicate rows.
 */
export async function extendActiveSeries(): Promise<{
  seriesProcessed: number;
  appointmentsCreated: number;
}> {
  const now = new Date();
  const horizonEnd = dayjs()
    .add(config.RECURRING_HORIZON_DAYS, "day")
    .toDate();

  const active = await db
    .select()
    .from(recurringSeries)
    .where(eq(recurringSeries.active, true));

  let appointmentsCreated = 0;
  let seriesProcessed = 0;

  for (const s of active) {
    const seriesHorizon =
      s.endDate && s.endDate < horizonEnd ? s.endDate : horizonEnd;
    const currentThrough = s.materializedThrough ?? s.anchorStart;
    if (currentThrough >= seriesHorizon) continue;

    seriesProcessed++;

    const allOccs = enumerateOccurrences(
      s.anchorStart,
      s.anchorEnd,
      s.frequency as Frequency,
      seriesHorizon
    );
    const newOccs = allOccs.filter((o) => o.start > currentThrough);
    if (newOccs.length === 0) {
      await db
        .update(recurringSeries)
        .set({ materializedThrough: seriesHorizon })
        .where(eq(recurringSeries.id, s.id));
      continue;
    }

    const windows = await loadScheduleWindows(s.therapistId);
    const valid = newOccs.filter((o) => occurrenceMatchesSchedule(o, windows));

    for (const occ of valid) {
      try {
        await db.insert(appointments).values({
          patientId: s.patientId,
          therapistId: s.therapistId,
          startTime: occ.start,
          endTime: occ.end,
          status: "scheduled",
          seriesId: s.id,
        });
        appointmentsCreated++;
      } catch (err: unknown) {
        const pgErr = err as { code?: string };
        if (pgErr?.code === "23505") {
          logger.info(
            {
              seriesId: s.id,
              start: occ.start.toISOString(),
            },
            "Skipped extension due to conflict"
          );
        } else {
          throw err;
        }
      }
    }

    await db
      .update(recurringSeries)
      .set({ materializedThrough: seriesHorizon })
      .where(eq(recurringSeries.id, s.id));
  }

  return { seriesProcessed, appointmentsCreated };
}

// small helper to keep sql import used (drizzle) — silences unused import if unneeded
export const _sql = sql;
