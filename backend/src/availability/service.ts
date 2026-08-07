import { and, eq, gte, lt, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import { schedules, appointments, therapists } from "../db/schema.js";
import { redis, RedisKeys } from "../redis.js";
import {
  APP_TZ,
  combineDateAndTimeInAppTz,
  dayjs,
  isoDatesBetween,
} from "../lib/time.js";
import { BadRequest, NotFound } from "../lib/errors.js";
import { config } from "../config.js";

export type SlotStatus =
  | "available"
  | "held_by_me"
  | "held_by_other"
  | "booked";

export interface Slot {
  therapistId: string;
  scheduleId: string;
  startTime: string; // ISO UTC
  endTime: string; // ISO UTC
  status: SlotStatus;
}

interface Params {
  therapistId: string;
  fromISODate: string; // YYYY-MM-DD in APP_TZ
  toISODate: string;
  requestingPatientId?: string;
}

export async function getAvailability({
  therapistId,
  fromISODate,
  toISODate,
  requestingPatientId,
}: Params): Promise<{ slots: Slot[]; timezone: string }> {
  const from = dayjs.tz(fromISODate, APP_TZ);
  const to = dayjs.tz(toISODate, APP_TZ);
  if (!from.isValid() || !to.isValid()) {
    throw BadRequest("Invalid from/to date (expected YYYY-MM-DD)");
  }
  if (to.isBefore(from, "day")) {
    throw BadRequest("`to` must be >= `from`");
  }
  const spanDays = to.diff(from, "day") + 1;
  if (spanDays > config.AVAILABILITY_MAX_DAYS) {
    throw BadRequest(
      `Requested range exceeds ${config.AVAILABILITY_MAX_DAYS} days`
    );
  }

  const [t] = await db
    .select()
    .from(therapists)
    .where(eq(therapists.id, therapistId))
    .limit(1);
  if (!t) throw NotFound("Therapist not found");

  const scheduleRows = await db
    .select()
    .from(schedules)
    .where(eq(schedules.therapistId, therapistId));

  // Materialize candidate slots across the requested date range.
  const now = dayjs();
  const candidates: {
    scheduleId: string;
    startDate: Date;
    endDate: Date;
    startISO: string;
    endISO: string;
  }[] = [];

  for (const day of isoDatesBetween(fromISODate, toISODate)) {
    const dow = dayjs.tz(day, APP_TZ).day();
    const rowsForDay = scheduleRows.filter((r) => r.dayOfWeek === dow);
    for (const row of rowsForDay) {
      const start = combineDateAndTimeInAppTz(day, row.startTime);
      const end = combineDateAndTimeInAppTz(day, row.endTime);
      if (dayjs(start).isBefore(now)) continue; // hide past slots
      candidates.push({
        scheduleId: row.id,
        startDate: start,
        endDate: end,
        startISO: start.toISOString(),
        endISO: end.toISOString(),
      });
    }
  }

  if (candidates.length === 0) {
    return { slots: [], timezone: APP_TZ };
  }

  // Query booked (non-cancelled) appointments for this therapist in range.
  const rangeStart = candidates[0].startDate;
  const rangeEnd = candidates[candidates.length - 1].endDate;
  const bookedRows = await db
    .select({
      startTime: appointments.startTime,
    })
    .from(appointments)
    .where(
      and(
        eq(appointments.therapistId, therapistId),
        gte(appointments.startTime, rangeStart),
        lt(appointments.startTime, rangeEnd),
        ne(appointments.status, "cancelled")
      )
    );
  const bookedSet = new Set(
    bookedRows.map((r) => new Date(r.startTime).toISOString())
  );

  // Batch-check holds via MGET; O(1) round-trip regardless of slot count.
  const holdKeys = candidates.map((c) =>
    RedisKeys.hold(therapistId, c.startISO)
  );
  const holdValues = holdKeys.length ? await redis.mget(...holdKeys) : [];

  const slots: Slot[] = candidates.map((c, i) => {
    const startISO = c.startISO;
    let status: SlotStatus = "available";
    if (bookedSet.has(startISO)) {
      status = "booked";
    } else if (holdValues[i]) {
      status =
        holdValues[i] === requestingPatientId ? "held_by_me" : "held_by_other";
    }
    return {
      therapistId,
      scheduleId: c.scheduleId,
      startTime: startISO,
      endTime: c.endISO,
      status,
    };
  });

  return { slots, timezone: APP_TZ };
}
