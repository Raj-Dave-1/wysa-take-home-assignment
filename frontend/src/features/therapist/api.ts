import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import type {
  Appointment,
  AppointmentStatus,
  ScheduleRow,
  TherapistAppointment,
} from "../../types/api";

export const therapistKeys = {
  all: ["therapist"] as const,
  appointments: () => [...therapistKeys.all, "appointments"] as const,
  schedule: () => [...therapistKeys.all, "schedule"] as const,
};

export function useAssignedAppointments() {
  return useQuery({
    queryKey: therapistKeys.appointments(),
    queryFn: () =>
      api<{ appointments: TherapistAppointment[] }>("/therapist/appointments"),
    select: (d) => d.appointments,
    refetchInterval: 30_000,
  });
}

export function useOwnSchedule() {
  return useQuery({
    queryKey: therapistKeys.schedule(),
    queryFn: () => api<{ schedule: ScheduleRow[] }>("/therapist/schedule"),
    select: (d) => d.schedule,
  });
}

export function useUpdateStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; status: Exclude<AppointmentStatus, "scheduled"> }) =>
      api<{ appointment: Appointment }>(`/appointments/${input.id}/status`, {
        method: "PATCH",
        body: { status: input.status },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: therapistKeys.appointments() });
    },
  });
}

export function useReplaceSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (schedule: ScheduleRow[]) =>
      api<{ updated: number }>("/therapist/schedule", {
        method: "PUT",
        body: { schedule },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: therapistKeys.schedule() });
    },
  });
}
