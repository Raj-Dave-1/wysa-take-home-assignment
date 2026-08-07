import { useEffect, useMemo, useState } from "react";
import { Spinner } from "../../components/Spinner";
import { dayjs, fmtDay, fmtRange, groupByDay } from "../../lib/time";
import { toast } from "../../components/Toast";
import { ApiError } from "../../lib/api";
import { useAssignedAppointments, useUpdateStatus } from "./api";
import type { AppointmentStatus, TherapistAppointment } from "../../types/api";

const statusBadge: Record<AppointmentStatus, string> = {
  scheduled: "bg-brand-50 text-brand-700 border border-brand-100",
  completed: "bg-emerald-50 text-emerald-700 border border-emerald-100",
  no_show: "bg-amber-50 text-amber-700 border border-amber-100",
  cancelled: "bg-slate-100 text-slate-500 border border-slate-200",
};

type Filter = "upcoming" | "today" | "past";

export function AssignedAppointments() {
  const { data, isLoading, isFetching } = useAssignedAppointments();
  const updateStatus = useUpdateStatus();
  const [filter, setFilter] = useState<Filter>("upcoming");

  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const filtered = useMemo(() => {
    const now = dayjs();
    return (data ?? []).filter((a) => {
      const start = dayjs(a.startTime);
      if (filter === "today") return start.isSame(now, "day");
      if (filter === "upcoming") return start.isAfter(now.subtract(1, "hour"));
      return start.isBefore(now.subtract(1, "hour"));
    });
  }, [data, filter]);

  const grouped = useMemo(() => {
    const items = [...filtered].sort((a, b) =>
      filter === "past"
        ? b.startTime.localeCompare(a.startTime)
        : a.startTime.localeCompare(b.startTime)
    );
    return groupByDay(items);
  }, [filtered, filter]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24 text-slate-400">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  const onMark = (
    a: TherapistAppointment,
    status: Exclude<AppointmentStatus, "scheduled">
  ) =>
    updateStatus.mutate(
      { id: a.id, status },
      {
        onSuccess: () => toast.success(`Marked as ${status.replace("_", " ")}`),
        onError: (e) => toast.error(e instanceof ApiError ? e.message : "Update failed"),
      }
    );

  return (
    <div>
      <div className="mb-6 flex items-center gap-2">
        {(["upcoming", "today", "past"] as Filter[]).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={
              filter === f
                ? "rounded-full bg-brand-600 px-3 py-1 text-xs font-medium text-white capitalize"
                : "rounded-full bg-white border border-slate-200 px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 capitalize"
            }
          >
            {f}
          </button>
        ))}
        {isFetching && (
          <span className="ml-auto flex items-center gap-1 text-xs text-slate-400">
            <Spinner className="h-3 w-3" /> refreshing
          </span>
        )}
      </div>

      {grouped.length === 0 ? (
        <div className="card p-10 text-center">
          <div className="text-3xl">🌱</div>
          <div className="mt-2 text-slate-700 font-medium">No appointments</div>
          <div className="text-sm text-slate-500">Nothing on the books for this filter.</div>
        </div>
      ) : (
        <div className="space-y-6">
          {grouped.map((day) => (
            <section key={day.day}>
              <h3 className="mb-3 text-sm font-semibold text-slate-500 uppercase tracking-wide">
                {day.label}
              </h3>
              <ul className="space-y-2">
                {day.items.map((a) => (
                  <AppointmentRow
                    key={a.id}
                    appt={a}
                    busy={updateStatus.isPending}
                    onMark={onMark}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function AppointmentRow({
  appt,
  busy,
  onMark,
}: {
  appt: TherapistAppointment;
  busy: boolean;
  onMark: (a: TherapistAppointment, status: Exclude<AppointmentStatus, "scheduled">) => void;
}) {
  const now = dayjs();
  const start = dayjs(appt.startTime);
  const end = dayjs(appt.endTime);
  const inWindow = now.isAfter(start) && now.isBefore(end);
  const isScheduled = appt.status === "scheduled";
  const canAct = isScheduled && inWindow;

  let windowHint = "";
  if (isScheduled && !inWindow) {
    if (now.isBefore(start)) {
      windowHint = `Available in ${start.from(now, true)}`;
    } else {
      windowHint = `Window closed ${end.from(now)}`;
    }
  }

  return (
    <li className="card p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-brand-50 text-brand-700 text-sm font-semibold">
            {initials(appt.patientName)}
          </div>
          <div>
            <div className="text-sm font-medium text-slate-900">{appt.patientName}</div>
            <div className="text-xs text-slate-500 mt-0.5">
              {fmtDay(appt.startTime)} · {fmtRange(appt.startTime, appt.endTime)}
              {appt.seriesId && (
                <span className="ml-2 badge bg-brand-50 text-brand-700 border border-brand-100">
                  Series
                </span>
              )}
            </div>
          </div>
        </div>
        <span className={`badge ${statusBadge[appt.status]}`}>
          {appt.status.replace("_", " ")}
        </span>
      </div>

      {isScheduled && (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
          {canAct ? (
            <>
              <button
                className="btn-primary"
                disabled={busy}
                onClick={() => onMark(appt, "completed")}
              >
                Mark completed
              </button>
              <button
                className="btn-secondary"
                disabled={busy}
                onClick={() => onMark(appt, "no_show")}
              >
                No-show
              </button>
              <button
                className="btn-ghost text-rose-600 hover:bg-rose-50"
                disabled={busy}
                onClick={() => onMark(appt, "cancelled")}
              >
                Cancel
              </button>
            </>
          ) : (
            <div className="text-xs text-slate-500 italic">{windowHint}</div>
          )}
        </div>
      )}
    </li>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join("");
}
