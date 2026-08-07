export type SlotStatus = "available" | "held_by_me" | "held_by_other" | "booked";

export interface Therapist {
  id: string;
  displayName: string;
}

export interface Slot {
  therapistId: string;
  scheduleId: string;
  startTime: string;
  endTime: string;
  status: SlotStatus;
}

export interface Hold {
  therapistId: string;
  startTime: string;
  endTime: string;
  holdKey: string;
  patientKey: string;
  expiresAt: string;
  remainingSeconds: number;
}

export type AppointmentStatus =
  | "scheduled"
  | "completed"
  | "no_show"
  | "cancelled";

export interface Appointment {
  id: string;
  patientId: string;
  therapistId: string;
  startTime: string;
  endTime: string;
  status: AppointmentStatus;
  seriesId: string | null;
  createdAt?: string;
}

export interface TherapistAppointment extends Appointment {
  patientName: string;
}

export type Frequency = "daily" | "weekly" | "biweekly" | "monthly";

export interface Series {
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

export interface ScheduleRow {
  id?: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}
