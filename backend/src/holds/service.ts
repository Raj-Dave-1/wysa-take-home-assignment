import { and, eq, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import { appointments, schedules, therapists } from "../db/schema.js";
import { redis, RedisKeys } from "../redis.js";
import { BadRequest, Conflict, NotFound } from "../lib/errors.js";
import { config } from "../config.js";
import {
  APP_TZ,
  combineDateAndTimeInAppTz,
  dayjs,
} from "../lib/time.js";

export interface HoldInfo {
  therapistId: string;
  startTime: string;
  endTime: string;
  holdKey: string;
  patientKey: string;
  expiresAt: string;
  remainingSeconds: number;
}

/**
 * Validate that the requested (therapistId, startTime, endTime) triple
 * actually corresponds to a real schedule slot on that day. This prevents
 * a malicious/buggy client from holding arbitrary time windows.
 */
async function assertSlotIsValid(
  therapistId: string,
  startTime: Date,
  endTime: Date
) {
  const now = new Date();
  if (startTime <= now) throw BadRequest("Slot is in the past");
  if (endTime <= startTime) throw BadRequest("End must be after start");

  const [t] = await db
    .select()
    .from(therapists)
    .where(eq(therapists.id, therapistId))
    .limit(1);
  if (!t) throw NotFound("Therapist not found");

  const dayISO = dayjs.tz(startTime, APP_TZ).format("YYYY-MM-DD");
  const dow = dayjs.tz(startTime, APP_TZ).day();

  const scheduleRows = await db
    .select()
    .from(schedules)
    .where(
      and(eq(schedules.therapistId, therapistId), eq(schedules.dayOfWeek, dow))
    );

  const match = scheduleRows.find((r) => {
    const s = combineDateAndTimeInAppTz(dayISO, r.startTime).getTime();
    const e = combineDateAndTimeInAppTz(dayISO, r.endTime).getTime();
    return s === startTime.getTime() && e === endTime.getTime();
  });
  if (!match) {
    throw BadRequest("Slot does not match any therapist schedule window");
  }
}

async function assertNotBooked(therapistId: string, startTime: Date) {
  const rows = await db
    .select({ id: appointments.id })
    .from(appointments)
    .where(
      and(
        eq(appointments.therapistId, therapistId),
        eq(appointments.startTime, startTime),
        ne(appointments.status, "cancelled")
      )
    )
    .limit(1);
  if (rows.length > 0) throw Conflict("Slot already booked");
}

export async function acquireHold(params: {
  patientId: string;
  therapistId: string;
  startTime: Date;
  endTime: Date;
}): Promise<HoldInfo> {
  const { patientId, therapistId, startTime, endTime } = params;

  await assertSlotIsValid(therapistId, startTime, endTime);
  await assertNotBooked(therapistId, startTime);

  const startISO = startTime.toISOString();
  const endISO = endTime.toISOString();
  const slotKey = RedisKeys.hold(therapistId, startISO);
  const patientKey = RedisKeys.patientHold(patientId);
  const ttl = config.HOLD_TTL_SECONDS;

  const reverseValue = JSON.stringify({
    therapistId,
    startTime: startISO,
    endTime: endISO,
    holdKey: slotKey,
  });

  const result = await redis.acquireHold(
    slotKey,
    patientKey,
    patientId,
    ttl,
    reverseValue
  );

  if (result === -1) {
    throw Conflict(
      "You already have an active hold. Release it or wait for it to expire."
    );
  }
  if (result === 0) {
    throw Conflict("Slot is currently held by another patient");
  }

  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

  return {
    therapistId,
    startTime: startISO,
    endTime: endISO,
    holdKey: slotKey,
    patientKey,
    expiresAt,
    remainingSeconds: ttl,
  };
}

export async function getMyHold(patientId: string): Promise<HoldInfo | null> {
  const patientKey = RedisKeys.patientHold(patientId);
  const raw = await redis.get(patientKey);
  if (!raw) return null;
  const ttl = await redis.ttl(patientKey);
  if (ttl < 0) return null;
  const parsed = JSON.parse(raw) as {
    therapistId: string;
    startTime: string;
    endTime: string;
    holdKey: string;
  };
  return {
    therapistId: parsed.therapistId,
    startTime: parsed.startTime,
    endTime: parsed.endTime,
    holdKey: parsed.holdKey,
    patientKey,
    expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    remainingSeconds: ttl,
  };
}

export async function releaseMyHold(patientId: string): Promise<boolean> {
  const existing = await getMyHold(patientId);
  if (!existing) return false;
  const result = await redis.releaseHold(
    existing.holdKey,
    existing.patientKey,
    patientId
  );
  return result === 1;
}
