import { and, asc, desc, eq, gte, lte, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import { appointments } from "../db/schema.js";
import { redis, RedisKeys } from "../redis.js";
import { redlock } from "../lib/lock.js";
import {
  BadRequest,
  Conflict,
  Forbidden,
  Gone,
  NotFound,
} from "../lib/errors.js";
import { logger } from "../lib/logger.js";

const BOOK_LOCK_TTL_MS = 8_000;

export interface AppointmentRow {
  id: string;
  patientId: string;
  therapistId: string;
  startTime: string;
  endTime: string;
  status: "scheduled" | "completed" | "no_show" | "cancelled";
  seriesId: string | null;
  createdAt: string;
}

function toRow(a: typeof appointments.$inferSelect): AppointmentRow {
  return {
    id: a.id,
    patientId: a.patientId,
    therapistId: a.therapistId,
    startTime: a.startTime.toISOString(),
    endTime: a.endTime.toISOString(),
    status: a.status,
    seriesId: a.seriesId,
    createdAt: a.createdAt.toISOString(),
  };
}

/**
 * Confirm the patient's active hold as a one-time appointment.
 *
 * Assumptions on entry:
 *  - Idempotency has already been checked (this runs inside withIdempotency).
 *  - The caller is authenticated as a PATIENT.
 *
 * Flow (three layers of defense):
 *  1. Redlock on `lock:appt:{therapist}:{startTime}`     — cross-cluster mutual exclusion
 *  2. Redis `consumeHold` Lua script                     — only the hold owner may book
 *  3. DB partial unique index on (therapist_id, start_time) WHERE status<>'cancelled'
 *                                                         — final safety net
 */
export async function bookOneTimeAppointment(params: {
  patientId: string;
  therapistId: string;
  startTime: Date;
  endTime: Date;
}): Promise<AppointmentRow> {
  const { patientId, therapistId, startTime, endTime } = params;

  if (endTime <= startTime) throw BadRequest("End must be after start");
  if (startTime <= new Date()) throw BadRequest("Slot is in the past");

  const startISO = startTime.toISOString();
  const slotKey = RedisKeys.hold(therapistId, startISO);
  const patientKey = RedisKeys.patientHold(patientId);
  const lockResource = RedisKeys.bookLock(therapistId, startISO);

  const lock = await redlock.acquire([lockResource], BOOK_LOCK_TTL_MS);
  try {
    // Layer 1: verify the caller owns the hold, and consume it atomically.
    // If TTL expired (or someone else has it), consumeHold returns 0.
    const consumed = await redis.consumeHold(slotKey, patientKey, patientId);
    if (consumed !== 1) {
      // Was the slot booked by someone else in the meantime? Give the caller
      // the most specific error we can.
      const existing = await db
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
      if (existing.length > 0) throw Conflict("Slot already booked");
      throw Gone("Hold expired or you do not own this hold");
    }

    // Layer 2: insert, relying on the partial unique index as the final guard.
    try {
      const [inserted] = await db
        .insert(appointments)
        .values({
          patientId,
          therapistId,
          startTime,
          endTime,
          status: "scheduled",
        })
        .returning();
      return toRow(inserted);
    } catch (err: unknown) {
      const pgErr = err as { code?: string; constraint?: string };
      if (pgErr?.code === "23505") {
        logger.warn(
          { err, patientId, therapistId, startISO },
          "Unique index tripped — race caught by DB"
        );
        throw Conflict("Slot already booked");
      }
      throw err;
    }
  } finally {
    try {
      await lock.release();
    } catch (err) {
      logger.warn({ err }, "Book lock release failed (harmless)");
    }
  }
}

export async function listPatientAppointments(patientId: string, opts: {
  from?: Date;
  to?: Date;
}) {
  const conds = [eq(appointments.patientId, patientId)];
  if (opts.from) conds.push(gte(appointments.startTime, opts.from));
  if (opts.to) conds.push(lte(appointments.startTime, opts.to));

  const rows = await db
    .select()
    .from(appointments)
    .where(and(...conds))
    .orderBy(asc(appointments.startTime));

  return rows.map(toRow);
}

export async function listTherapistAppointments(therapistId: string, opts: {
  from?: Date;
  to?: Date;
}) {
  const conds = [eq(appointments.therapistId, therapistId)];
  if (opts.from) conds.push(gte(appointments.startTime, opts.from));
  if (opts.to) conds.push(lte(appointments.startTime, opts.to));

  const rows = await db
    .select()
    .from(appointments)
    .where(and(...conds))
    .orderBy(asc(appointments.startTime));

  return rows.map(toRow);
}

/**
 * Therapist updates an appointment's status. Guards:
 *  - Only the assigned therapist may update
 *  - Current status must be `scheduled` (completed / no_show / cancelled are terminal)
 *  - `now` must fall within the appointment window [start_time, end_time]
 *    (per assignment: "Update an appointment's status during its appointment window")
 */
export async function updateAppointmentStatusByTherapist(params: {
  therapistId: string;
  appointmentId: string;
  newStatus: "completed" | "no_show" | "cancelled";
}): Promise<AppointmentRow> {
  const { therapistId, appointmentId, newStatus } = params;

  const [existing] = await db
    .select()
    .from(appointments)
    .where(eq(appointments.id, appointmentId))
    .limit(1);
  if (!existing) throw NotFound("Appointment not found");
  if (existing.therapistId !== therapistId) throw Forbidden();

  if (existing.status !== "scheduled") {
    throw BadRequest(
      `Cannot transition from '${existing.status}' — status is terminal`
    );
  }

  const now = new Date();
  if (now < existing.startTime || now > existing.endTime) {
    throw BadRequest(
      "Status can only be updated during the appointment window"
    );
  }

  const [updated] = await db
    .update(appointments)
    .set({ status: newStatus, updatedAt: now })
    .where(eq(appointments.id, appointmentId))
    .returning();

  return toRow(updated);
}

/**
 * Cancel a single one-time appointment. If the appointment belongs to a
 * recurring series, this cancels ONLY that instance — the series continues.
 * (Cancel-entire-series is a separate endpoint delivered in Phase 4.)
 */
export async function cancelAppointmentInstance(params: {
  patientId: string;
  appointmentId: string;
}) {
  const { patientId, appointmentId } = params;

  const [existing] = await db
    .select()
    .from(appointments)
    .where(eq(appointments.id, appointmentId))
    .limit(1);
  if (!existing) throw NotFound("Appointment not found");
  if (existing.patientId !== patientId) throw Forbidden();
  if (existing.status === "cancelled") return toRow(existing);
  if (existing.status === "completed" || existing.status === "no_show") {
    throw BadRequest(`Cannot cancel an appointment in status: ${existing.status}`);
  }
  if (existing.startTime <= new Date()) {
    throw BadRequest("Appointment has already started");
  }

  const [updated] = await db
    .update(appointments)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(eq(appointments.id, appointmentId))
    .returning();

  return toRow(updated);
}
