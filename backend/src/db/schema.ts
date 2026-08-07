import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  integer,
  boolean,
  pgEnum,
  time,
  date,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

export const userRoleEnum = pgEnum("user_role", ["PATIENT", "THERAPIST"]);

export const appointmentStatusEnum = pgEnum("appointment_status", [
  "scheduled",
  "completed",
  "no_show",
  "cancelled",
]);

export const recurrenceFrequencyEnum = pgEnum("recurrence_frequency", [
  "daily",
  "weekly",
  "biweekly",
  "monthly",
]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: varchar("email", { length: 255 }).notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    role: userRoleEnum("role").notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [uniqueIndex("users_email_idx").on(t.email)],
);

export const therapists = pgTable("therapists", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  displayName: varchar("display_name", { length: 255 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const patients = pgTable("patients", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  displayName: varchar("display_name", { length: 255 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

/**
 * Schedule = repeating weekly template. Each row = one available window on that weekday.
 * Slot start_time/end_time are stored as time-of-day (no date, no timezone).
 * dayOfWeek: 0 = Sunday .. 6 = Saturday (JS convention).
 */
export const schedules = pgTable(
  "schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    therapistId: uuid("therapist_id")
      .notNull()
      .references(() => therapists.id, { onDelete: "cascade" }),
    dayOfWeek: integer("day_of_week").notNull(),
    startTime: time("start_time").notNull(),
    endTime: time("end_time").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("schedules_therapist_day_idx").on(t.therapistId, t.dayOfWeek)],
);

export const recurringSeries = pgTable("recurring_series", {
  id: uuid("id").primaryKey().defaultRandom(),
  patientId: uuid("patient_id")
    .notNull()
    .references(() => patients.id, { onDelete: "cascade" }),
  therapistId: uuid("therapist_id")
    .notNull()
    .references(() => therapists.id, { onDelete: "cascade" }),
  frequency: recurrenceFrequencyEnum("frequency").notNull(),
  // anchor: first occurrence date + time-of-day. All future instances derived from these.
  anchorStart: timestamp("anchor_start", { withTimezone: true }).notNull(),
  anchorEnd: timestamp("anchor_end", { withTimezone: true }).notNull(),
  endDate: timestamp("end_date", { withTimezone: true }),
  // How far we've already materialized appointments up to (exclusive upper bound).
  materializedThrough: timestamp("materialized_through", {
    withTimezone: true,
  }),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const appointments = pgTable(
  "appointments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "restrict" }),
    therapistId: uuid("therapist_id")
      .notNull()
      .references(() => therapists.id, { onDelete: "restrict" }),
    startTime: timestamp("start_time", { withTimezone: true }).notNull(),
    endTime: timestamp("end_time", { withTimezone: true }).notNull(),
    status: appointmentStatusEnum("status").notNull().default("scheduled"),
    seriesId: uuid("series_id").references(() => recurringSeries.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    // Last-line defense against double-booking. A therapist can only have one
    // non-cancelled appointment at a given start time.
    uniqueIndex("appt_therapist_start_active_uq")
      .on(t.therapistId, t.startTime)
      .where(sql`status <> 'cancelled'`),
    index("appt_patient_idx").on(t.patientId, t.startTime),
    index("appt_therapist_idx").on(t.therapistId, t.startTime),
    index("appt_series_idx").on(t.seriesId),
  ],
);

// Relations (nice-to-have for query building)
export const usersRelations = relations(users, ({ one }) => ({
  therapist: one(therapists, {
    fields: [users.id],
    references: [therapists.userId],
  }),
  patient: one(patients, {
    fields: [users.id],
    references: [patients.userId],
  }),
}));

export const therapistsRelations = relations(therapists, ({ one, many }) => ({
  user: one(users, {
    fields: [therapists.userId],
    references: [users.id],
  }),
  schedules: many(schedules),
  appointments: many(appointments),
}));

export const patientsRelations = relations(patients, ({ one, many }) => ({
  user: one(users, {
    fields: [patients.userId],
    references: [users.id],
  }),
  appointments: many(appointments),
  series: many(recurringSeries),
}));

export const appointmentsRelations = relations(appointments, ({ one }) => ({
  patient: one(patients, {
    fields: [appointments.patientId],
    references: [patients.id],
  }),
  therapist: one(therapists, {
    fields: [appointments.therapistId],
    references: [therapists.id],
  }),
  series: one(recurringSeries, {
    fields: [appointments.seriesId],
    references: [recurringSeries.id],
  }),
}));

export const recurringSeriesRelations = relations(
  recurringSeries,
  ({ one, many }) => ({
    patient: one(patients, {
      fields: [recurringSeries.patientId],
      references: [patients.id],
    }),
    therapist: one(therapists, {
      fields: [recurringSeries.therapistId],
      references: [therapists.id],
    }),
    appointments: many(appointments),
  }),
);
