import { useMemo, useState } from "react";
import { Spinner } from "../../components/Spinner";
import { Modal } from "../../components/Modal";
import { fmtDay, fmtRange, dayjs } from "../../lib/time";
import { toast } from "../../components/Toast";
import { ApiError } from "../../lib/api";
import {
  useCancelAppointment,
  useCancelSeries,
  useMyAppointments,
  useMySeries,
  useTherapists,
} from "./api";
import type { Appointment, AppointmentStatus, Frequency, Series } from "../../types/api";

const statusBadge: Record<AppointmentStatus, string> = {
  scheduled: "bg-brand-50 text-brand-700 border border-brand-100",
  completed: "bg-emerald-50 text-emerald-700 border border-emerald-100",
  no_show: "bg-amber-50 text-amber-700 border border-amber-100",
  cancelled: "bg-slate-100 text-slate-500 border border-slate-200",
};

const freqLabel: Record<Frequency, string> = {
  daily: "Daily",
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  monthly: "Monthly",
};

export function MyBookings() {
  const { data: appts, isLoading: apptsLoading } = useMyAppointments();
  const { data: series, isLoading: seriesLoading } = useMySeries();
  const { data: therapists } = useTherapists();

  const therapistName = (id: string) =>
    therapists?.find((t) => t.id === id)?.displayName ?? "Therapist";

  const cancelAppt = useCancelAppointment();
  const cancelSer = useCancelSeries();

  const [confirmCancel, setConfirmCancel] = useState<
    | { kind: "appt"; id: string; label: string }
    | { kind: "series"; id: string; label: string; futureCount: number }
    | null
  >(null);

  const upcoming = useMemo(
    () =>
      (appts ?? [])
        .filter(
          (a) => a.status === "scheduled" && dayjs(a.startTime).isAfter(dayjs().subtract(1, "hour"))
        )
        .sort((a, b) => a.startTime.localeCompare(b.startTime)),
    [appts]
  );
  const past = useMemo(
    () =>
      (appts ?? [])
        .filter(
          (a) => a.status !== "scheduled" || dayjs(a.startTime).isBefore(dayjs().subtract(1, "hour"))
        )
        .sort((a, b) => b.startTime.localeCompare(a.startTime))
        .slice(0, 20),
    [appts]
  );

  const activeSeries = useMemo(
    () => (series ?? []).filter((s) => s.active),
    [series]
  );

  const futureInstancesInSeries = (seriesId: string) =>
    (appts ?? []).filter(
      (a) =>
        a.seriesId === seriesId &&
        a.status === "scheduled" &&
        dayjs(a.startTime).isAfter(dayjs())
    ).length;

  if (apptsLoading || seriesLoading) {
    return (
      <div className="flex items-center justify-center py-24 text-slate-400">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  const doCancelAppt = (id: string) =>
    cancelAppt.mutate(id, {
      onSuccess: () => {
        toast.success("Appointment cancelled");
        setConfirmCancel(null);
      },
      onError: (e) => toast.error(e instanceof ApiError ? e.message : "Cancel failed"),
    });

  const doCancelSeries = (id: string) =>
    cancelSer.mutate(id, {
      onSuccess: (res) => {
        toast.success(`Series cancelled · ${res.cancelledCount} future appointments removed`);
        setConfirmCancel(null);
      },
      onError: (e) => toast.error(e instanceof ApiError ? e.message : "Cancel failed"),
    });

  return (
    <div className="space-y-8">
      <section>
        <h3 className="mb-3 text-lg font-semibold text-slate-900">Upcoming</h3>
        {upcoming.length === 0 ? (
          <div className="card p-8 text-center text-sm text-slate-500">
            No upcoming appointments. Head to Availability to book one.
          </div>
        ) : (
          <ul className="space-y-2">
            {upcoming.map((a) => (
              <AppointmentRow
                key={a.id}
                appt={a}
                therapistName={therapistName(a.therapistId)}
                onCancel={() =>
                  setConfirmCancel({
                    kind: "appt",
                    id: a.id,
                    label: `${fmtDay(a.startTime)} · ${fmtRange(a.startTime, a.endTime)}`,
                  })
                }
              />
            ))}
          </ul>
        )}
      </section>

      {activeSeries.length > 0 && (
        <section>
          <h3 className="mb-3 text-lg font-semibold text-slate-900">Recurring series</h3>
          <ul className="space-y-2">
            {activeSeries.map((s) => (
              <SeriesRow
                key={s.id}
                series={s}
                therapistName={therapistName(s.therapistId)}
                futureCount={futureInstancesInSeries(s.id)}
                onCancel={() =>
                  setConfirmCancel({
                    kind: "series",
                    id: s.id,
                    label: `${freqLabel[s.frequency]} · started ${fmtDay(s.anchorStart)}`,
                    futureCount: futureInstancesInSeries(s.id),
                  })
                }
              />
            ))}
          </ul>
        </section>
      )}

      {past.length > 0 && (
        <section>
          <h3 className="mb-3 text-lg font-semibold text-slate-900">Recent history</h3>
          <ul className="space-y-2">
            {past.map((a) => (
              <AppointmentRow
                key={a.id}
                appt={a}
                therapistName={therapistName(a.therapistId)}
                readOnly
              />
            ))}
          </ul>
        </section>
      )}

      {confirmCancel && (
        <Modal
          open
          onClose={() => setConfirmCancel(null)}
          title={confirmCancel.kind === "appt" ? "Cancel appointment?" : "Cancel entire series?"}
          size="sm"
          footer={
            <>
              <button className="btn-secondary" onClick={() => setConfirmCancel(null)}>
                Keep it
              </button>
              <button
                className="btn-danger"
                onClick={() =>
                  confirmCancel.kind === "appt"
                    ? doCancelAppt(confirmCancel.id)
                    : doCancelSeries(confirmCancel.id)
                }
                disabled={cancelAppt.isPending || cancelSer.isPending}
              >
                {(cancelAppt.isPending || cancelSer.isPending) && (
                  <Spinner className="h-4 w-4" />
                )}
                {confirmCancel.kind === "appt" ? "Cancel appointment" : "Cancel series"}
              </button>
            </>
          }
        >
          <p className="text-sm text-slate-600">
            {confirmCancel.kind === "appt" ? (
              <>
                This will free up your slot on{" "}
                <span className="font-medium text-slate-900">{confirmCancel.label}</span>.
              </>
            ) : (
              <>
                This will cancel <span className="font-medium text-slate-900">
                  {confirmCancel.futureCount}
                </span>{" "}
                future appointments in the series ({confirmCancel.label}). Past sessions are
                not affected.
              </>
            )}
          </p>
        </Modal>
      )}
    </div>
  );
}

function AppointmentRow({
  appt,
  therapistName,
  onCancel,
  readOnly,
}: {
  appt: Appointment;
  therapistName: string;
  onCancel?: () => void;
  readOnly?: boolean;
}) {
  return (
    <li className="card flex items-center justify-between p-4">
      <div className="flex items-center gap-4">
        <div className="flex flex-col items-center rounded-xl bg-slate-50 border border-slate-100 px-3 py-2 min-w-[64px]">
          <div className="text-[10px] uppercase tracking-wide text-slate-500">
            {dayjs(appt.startTime).format("MMM")}
          </div>
          <div className="text-lg font-semibold text-slate-900 leading-none">
            {dayjs(appt.startTime).format("D")}
          </div>
        </div>
        <div>
          <div className="text-sm font-medium text-slate-900">
            {fmtRange(appt.startTime, appt.endTime)}
          </div>
          <div className="text-xs text-slate-500 flex items-center gap-2 mt-0.5">
            <span>{therapistName}</span>
            {appt.seriesId && (
              <span className="badge bg-brand-50 text-brand-700 border border-brand-100">
                Part of series
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className={`badge ${statusBadge[appt.status]}`}>{appt.status.replace("_", " ")}</span>
        {onCancel && !readOnly && (
          <button className="btn-ghost text-rose-600 hover:bg-rose-50" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </li>
  );
}

function SeriesRow({
  series,
  therapistName,
  futureCount,
  onCancel,
}: {
  series: Series;
  therapistName: string;
  futureCount: number;
  onCancel: () => void;
}) {
  return (
    <li className="card flex items-center justify-between p-4">
      <div className="flex items-center gap-4">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 6v6l4 2" />
            <circle cx="12" cy="12" r="9" />
          </svg>
        </div>
        <div>
          <div className="text-sm font-medium text-slate-900">
            {freqLabel[series.frequency]} · {fmtRange(series.anchorStart, series.anchorEnd)}
          </div>
          <div className="text-xs text-slate-500 mt-0.5">
            {therapistName} · started {fmtDay(series.anchorStart)}
            {series.endDate && ` · ends ${fmtDay(series.endDate)}`}
            {" · "}
            {futureCount} upcoming
          </div>
        </div>
      </div>
      <button className="btn-ghost text-rose-600 hover:bg-rose-50" onClick={onCancel}>
        Cancel series
      </button>
    </li>
  );
}
