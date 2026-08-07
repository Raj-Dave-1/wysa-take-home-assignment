import bcrypt from "bcryptjs";
import { db, pool } from "./index.js";
import { users, therapists, patients, schedules } from "./schema.js";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger.js";

/**
 * Seeds:
 * - 2 patient users  (patient@test.com, patient2@test.com — password: 123456)
 * - 2 therapist users (therapist@test.com, therapist2@test.com — password: 123456)
 * - Each therapist gets a distinct weekly schedule so patients see real variety.
 * Idempotent — safe to re-run any time; upserts by email and wipes/replaces
 * each therapist's schedule.
 */

// dayOfWeek: 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat

// Tanuj mostly works afternoons + evenings, skips Wednesdays and weekends.
// Matches the assignment example.
const TANUJ_SCHEDULE = [
  { dayOfWeek: 1, startTime: "10:00", endTime: "10:30" },
  { dayOfWeek: 1, startTime: "13:30", endTime: "14:00" },
  { dayOfWeek: 1, startTime: "14:30", endTime: "15:00" },
  { dayOfWeek: 1, startTime: "15:30", endTime: "16:30" },
  { dayOfWeek: 2, startTime: "16:30", endTime: "17:00" },
  { dayOfWeek: 2, startTime: "17:00", endTime: "17:30" },
  { dayOfWeek: 2, startTime: "17:30", endTime: "18:00" },
  { dayOfWeek: 4, startTime: "13:30", endTime: "14:00" },
  { dayOfWeek: 4, startTime: "14:00", endTime: "14:30" },
  { dayOfWeek: 4, startTime: "14:30", endTime: "15:00" },
  { dayOfWeek: 4, startTime: "15:30", endTime: "16:30" },
  { dayOfWeek: 5, startTime: "10:00", endTime: "10:30" },
  { dayOfWeek: 5, startTime: "13:30", endTime: "14:00" },
  { dayOfWeek: 5, startTime: "14:30", endTime: "15:00" },
  { dayOfWeek: 5, startTime: "15:30", endTime: "16:30" },
];

// Maya covers what Tanuj doesn't — early mornings, Wednesdays, and weekends.
// Gives patients a real second option when Tanuj is fully booked or off.
const MAYA_SCHEDULE = [
  // Sunday morning
  { dayOfWeek: 0, startTime: "10:00", endTime: "10:30" },
  { dayOfWeek: 0, startTime: "10:30", endTime: "11:00" },
  { dayOfWeek: 0, startTime: "11:00", endTime: "11:30" },
  // Monday early morning
  { dayOfWeek: 1, startTime: "08:00", endTime: "08:30" },
  { dayOfWeek: 1, startTime: "08:30", endTime: "09:00" },
  // Wednesday full day
  { dayOfWeek: 3, startTime: "09:00", endTime: "09:30" },
  { dayOfWeek: 3, startTime: "10:00", endTime: "10:30" },
  { dayOfWeek: 3, startTime: "11:00", endTime: "11:30" },
  { dayOfWeek: 3, startTime: "15:00", endTime: "15:30" },
  { dayOfWeek: 3, startTime: "16:00", endTime: "16:30" },
  { dayOfWeek: 3, startTime: "17:00", endTime: "17:30" },
  // Friday evening
  { dayOfWeek: 5, startTime: "18:00", endTime: "18:30" },
  { dayOfWeek: 5, startTime: "18:30", endTime: "19:00" },
  // Saturday morning
  { dayOfWeek: 6, startTime: "09:00", endTime: "09:30" },
  { dayOfWeek: 6, startTime: "10:00", endTime: "10:30" },
  { dayOfWeek: 6, startTime: "11:00", endTime: "11:30" },
];

interface SeedTherapist {
  email: string;
  displayName: string;
  schedule: typeof TANUJ_SCHEDULE;
}

const THERAPISTS: SeedTherapist[] = [
  {
    email: "therapist@test.com",
    displayName: "Dr. Tanuj Therapist",
    schedule: TANUJ_SCHEDULE,
  },
  {
    email: "therapist2@test.com",
    displayName: "Dr. Maya Mehta",
    schedule: MAYA_SCHEDULE,
  },
];

const PATIENTS = [
  { email: "patient@test.com", displayName: "Priya Patient" },
  { email: "patient2@test.com", displayName: "Paul Patient" },
];

async function upsertUser(email: string, name: string, role: "PATIENT" | "THERAPIST", passwordHash: string) {
  const [u] = await db
    .insert(users)
    .values({ email, passwordHash, role, name })
    .onConflictDoUpdate({
      target: users.email,
      set: { passwordHash, name },
    })
    .returning();
  return u;
}

async function ensurePatientProfile(userId: string, displayName: string) {
  const existing = await db
    .select()
    .from(patients)
    .where(eq(patients.userId, userId))
    .limit(1);
  if (existing.length === 0) {
    await db.insert(patients).values({ userId, displayName });
  }
}

async function ensureTherapistProfile(userId: string, displayName: string) {
  const existing = await db
    .select()
    .from(therapists)
    .where(eq(therapists.userId, userId))
    .limit(1);
  if (existing[0]) return existing[0];
  const [inserted] = await db
    .insert(therapists)
    .values({ userId, displayName })
    .returning();
  return inserted;
}

async function main() {
  logger.info("Seeding database...");
  const passwordHash = await bcrypt.hash("123456", 10);

  // Patients
  for (const p of PATIENTS) {
    const u = await upsertUser(p.email, p.displayName, "PATIENT", passwordHash);
    await ensurePatientProfile(u.id, p.displayName);
  }

  // Therapists (with schedules)
  const summary: { name: string; id: string; rows: number }[] = [];
  for (const t of THERAPISTS) {
    const u = await upsertUser(t.email, t.displayName, "THERAPIST", passwordHash);
    const profile = await ensureTherapistProfile(u.id, t.displayName);

    // Wipe + replace the therapist's schedule (idempotent).
    // Existing appointments are untouched — schedule is a template, not an FK.
    await db.delete(schedules).where(eq(schedules.therapistId, profile.id));
    await db.insert(schedules).values(
      t.schedule.map((s) => ({
        therapistId: profile.id,
        dayOfWeek: s.dayOfWeek,
        startTime: s.startTime,
        endTime: s.endTime,
      }))
    );

    summary.push({ name: t.displayName, id: profile.id, rows: t.schedule.length });
  }

  logger.info(
    { patients: PATIENTS.length, therapists: summary },
    "Seed complete"
  );

  await pool.end();
}

main().catch((err) => {
  logger.error({ err }, "Seed failed");
  process.exit(1);
});
