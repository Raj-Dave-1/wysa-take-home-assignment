import { and, asc, eq, gte, lte } from "drizzle-orm";
import { db } from "../db/index.js";
import { appointments, patients, schedules } from "../db/schema.js";
import { BadRequest } from "../lib/errors.js";

export interface TherapistAppointmentRow {
  id: string;
  patientId: string;
  patientName: string;
  therapistId: string;
  startTime: string;
  endTime: string;
  status: "scheduled" | "completed" | "no_show" | "cancelled";
  seriesId: string | null;
}

export async function listAssignedAppointments(
  therapistId: string,
  opts: { from?: Date; to?: Date }
): Promise<TherapistAppointmentRow[]> {
  const conds = [eq(appointments.therapistId, therapistId)];
  if (opts.from) conds.push(gte(appointments.startTime, opts.from));
  if (opts.to) conds.push(lte(appointments.startTime, opts.to));

  const rows = await db
    .select({
      id: appointments.id,
      patientId: appointments.patientId,
      patientName: patients.displayName,
      therapistId: appointments.therapistId,
      startTime: appointments.startTime,
      endTime: appointments.endTime,
      status: appointments.status,
      seriesId: appointments.seriesId,
    })
    .from(appointments)
    .innerJoin(patients, eq(patients.id, appointments.patientId))
    .where(and(...conds))
    .orderBy(asc(appointments.startTime));

  return rows.map((r) => ({
    ...r,
    startTime: r.startTime.toISOString(),
    endTime: r.endTime.toISOString(),
  }));
}

export interface ScheduleInputRow {
  dayOfWeek: number;
  startTime: string; // HH:mm
  endTime: string;   // HH:mm
}

/**
 * Replace the therapist's entire weekly schedule.
 *
 * Existing appointments are NEVER touched — they carry their own concrete
 * start/end datetimes and don't reference schedule rows. This is by design:
 * a schedule change only affects which slots the availability endpoint
 * offers going forward.
 *
 * Validation:
 *  - dayOfWeek 0..6
 *  - HH:mm times with end > start
 *  - no overlapping windows within the same day
 */
export async function replaceSchedule(
  therapistId: string,
  rows: ScheduleInputRow[]
) {
  const byDay = new Map<number, { s: number; e: number }[]>();
  for (const r of rows) {
    const [sh, sm] = r.startTime.split(":").map(Number);
    const [eh, em] = r.endTime.split(":").map(Number);
    const s = sh * 60 + sm;
    const e = eh * 60 + em;
    if (Number.isNaN(s) || Number.isNaN(e)) {
      throw BadRequest(`Invalid time: ${JSON.stringify(r)}`);
    }
    if (e <= s) {
      throw BadRequest(
        `endTime must be after startTime: ${JSON.stringify(r)}`
      );
    }
    if (!byDay.has(r.dayOfWeek)) byDay.set(r.dayOfWeek, []);
    byDay.get(r.dayOfWeek)!.push({ s, e });
  }
  for (const [day, ranges] of byDay) {
    ranges.sort((a, b) => a.s - b.s);
    for (let i = 1; i < ranges.length; i++) {
      if (ranges[i].s < ranges[i - 1].e) {
        throw BadRequest(`Overlapping windows on day ${day}`);
      }
    }
  }

  await db.transaction(async (tx) => {
    await tx.delete(schedules).where(eq(schedules.therapistId, therapistId));
    if (rows.length > 0) {
      await tx.insert(schedules).values(
        rows.map((r) => ({
          therapistId,
          dayOfWeek: r.dayOfWeek,
          startTime: r.startTime,
          endTime: r.endTime,
        }))
      );
    }
  });

  return { updated: rows.length };
}

export async function getOwnSchedule(therapistId: string) {
  const rows = await db
    .select({
      id: schedules.id,
      dayOfWeek: schedules.dayOfWeek,
      startTime: schedules.startTime,
      endTime: schedules.endTime,
    })
    .from(schedules)
    .where(eq(schedules.therapistId, therapistId))
    .orderBy(asc(schedules.dayOfWeek), asc(schedules.startTime));

  // Postgres `time` columns come back as "HH:MM:SS"; normalize to "HH:MM" so
  // the client can round-trip the value straight back to PUT /therapist/schedule.
  return rows.map((r) => ({
    ...r,
    startTime: r.startTime.slice(0, 5),
    endTime: r.endTime.slice(0, 5),
  }));
}
