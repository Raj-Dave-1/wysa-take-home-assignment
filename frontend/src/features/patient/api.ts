import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, newIdempotencyKey } from "../../lib/api";
import type {
  Appointment,
  Frequency,
  Hold,
  Series,
  Slot,
  Therapist,
} from "../../types/api";

export const patientKeys = {
  all: ["patient"] as const,
  therapists: () => [...patientKeys.all, "therapists"] as const,
  availability: (therapistId: string, from: string, to: string) =>
    [...patientKeys.all, "availability", therapistId, from, to] as const,
  myHold: () => [...patientKeys.all, "my-hold"] as const,
  myAppointments: () => [...patientKeys.all, "my-appointments"] as const,
  mySeries: () => [...patientKeys.all, "my-series"] as const,
};

export function useTherapists() {
  return useQuery({
    queryKey: patientKeys.therapists(),
    queryFn: () => api<{ therapists: Therapist[] }>("/therapists"),
    select: (d) => d.therapists,
  });
}

export function useAvailability(
  therapistId: string | undefined,
  from: string,
  to: string
) {
  return useQuery({
    queryKey: therapistId
      ? patientKeys.availability(therapistId, from, to)
      : ["patient", "availability", "empty"],
    queryFn: () =>
      api<{ slots: Slot[]; timezone: string; from: string; to: string }>(
        `/availability?therapistId=${therapistId}&from=${from}&to=${to}`
      ),
    enabled: !!therapistId,
    select: (d) => d.slots,
  });
}

export function useMyHold() {
  return useQuery({
    queryKey: patientKeys.myHold(),
    queryFn: () => api<{ hold: Hold | null }>("/holds/mine"),
    select: (d) => d.hold,
    refetchOnMount: "always",
  });
}

export function useMyAppointments() {
  return useQuery({
    queryKey: patientKeys.myAppointments(),
    queryFn: () => api<{ appointments: Appointment[] }>("/appointments"),
    select: (d) => d.appointments,
  });
}

export function useMySeries() {
  return useQuery({
    queryKey: patientKeys.mySeries(),
    queryFn: () => api<{ series: Series[] }>("/series"),
    select: (d) => d.series,
  });
}

export function useCreateHold() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { therapistId: string; startTime: string; endTime: string }) =>
      api<{ hold: Hold }>("/holds", { method: "POST", body: input }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: patientKeys.myHold() });
      qc.invalidateQueries({ queryKey: [...patientKeys.all, "availability"] });
    },
  });
}

export function useReleaseHold() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ released: boolean }>("/holds/mine", { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: patientKeys.myHold() });
      qc.invalidateQueries({ queryKey: [...patientKeys.all, "availability"] });
    },
  });
}

interface BookOneTimeInput {
  therapistId: string;
  startTime: string;
  endTime: string;
}
interface BookSeriesInput extends BookOneTimeInput {
  recurrence: { frequency: Frequency; endDate?: string };
}
type BookInput = BookOneTimeInput | BookSeriesInput;

interface BookResponse {
  appointment?: Appointment;
  series?: Series;
  appointments?: Appointment[];
  skipped?: number;
  horizonEnd?: string;
}

export function useConfirmBooking() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BookInput) =>
      api<BookResponse>("/appointments", {
        method: "POST",
        body: input,
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: patientKeys.myHold() });
      qc.invalidateQueries({ queryKey: patientKeys.myAppointments() });
      qc.invalidateQueries({ queryKey: patientKeys.mySeries() });
      qc.invalidateQueries({ queryKey: [...patientKeys.all, "availability"] });
    },
  });
}

export function useCancelAppointment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ appointment: Appointment }>(`/appointments/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: patientKeys.myAppointments() });
      qc.invalidateQueries({ queryKey: [...patientKeys.all, "availability"] });
    },
  });
}

export function useCancelSeries() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ seriesId: string; cancelledCount: number }>(`/series/${id}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: patientKeys.myAppointments() });
      qc.invalidateQueries({ queryKey: patientKeys.mySeries() });
      qc.invalidateQueries({ queryKey: [...patientKeys.all, "availability"] });
    },
  });
}
