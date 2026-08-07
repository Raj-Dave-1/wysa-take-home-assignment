import { useEffect, useMemo, useState } from "react";
import { Spinner } from "../../components/Spinner";
import { toast } from "../../components/Toast";
import { ApiError } from "../../lib/api";
import { useOwnSchedule, useReplaceSchedule } from "./api";
import type { ScheduleRow } from "../../types/api";

const DAYS = [
  { idx: 0, label: "Sunday", short: "Sun" },
  { idx: 1, label: "Monday", short: "Mon" },
  { idx: 2, label: "Tuesday", short: "Tue" },
  { idx: 3, label: "Wednesday", short: "Wed" },
  { idx: 4, label: "Thursday", short: "Thu" },
  { idx: 5, label: "Friday", short: "Fri" },
  { idx: 6, label: "Saturday", short: "Sat" },
];

interface WindowDraft {
  key: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

function fromRows(rows: ScheduleRow[]): WindowDraft[] {
  return rows.map((r, i) => ({
    key: `${r.dayOfWeek}-${i}-${r.startTime}`,
    dayOfWeek: r.dayOfWeek,
    startTime: r.startTime.slice(0, 5),
    endTime: r.endTime.slice(0, 5),
  }));
}

function newKey(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

export function ScheduleEditor() {
  const { data, isLoading } = useOwnSchedule();
  const replace = useReplaceSchedule();
  const [drafts, setDrafts] = useState<WindowDraft[]>([]);

  useEffect(() => {
    if (data) setDrafts(fromRows(data));
  }, [data]);

  const grouped = useMemo(() => {
    const byDay = new Map<number, WindowDraft[]>();
    for (const w of drafts) {
      if (!byDay.has(w.dayOfWeek)) byDay.set(w.dayOfWeek, []);
      byDay.get(w.dayOfWeek)!.push(w);
    }
    return byDay;
  }, [drafts]);

  const isDirty = useMemo(() => {
    if (!data) return false;
    const before = fromRows(data)
      .map((w) => `${w.dayOfWeek}|${w.startTime}|${w.endTime}`)
      .sort()
      .join(",");
    const after = drafts
      .map((w) => `${w.dayOfWeek}|${w.startTime}|${w.endTime}`)
      .sort()
      .join(",");
    return before !== after;
  }, [data, drafts]);

  const localErrors = useMemo(() => {
    const errs: string[] = [];
    for (const [day, windows] of grouped) {
      for (const w of windows) {
        if (w.endTime <= w.startTime) {
          errs.push(`${DAYS[day].label}: ${w.startTime}–${w.endTime} — end must be after start`);
        }
      }
      const sorted = [...windows].sort((a, b) => a.startTime.localeCompare(b.startTime));
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].startTime < sorted[i - 1].endTime) {
          errs.push(`${DAYS[day].label}: overlapping windows`);
          break;
        }
      }
    }
    return errs;
  }, [grouped]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24 text-slate-400">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  const addWindow = (day: number) => {
    const last = grouped.get(day)?.slice(-1)[0];
    const start = last?.endTime ?? "09:00";
    const [h, m] = start.split(":").map(Number);
    const endH = Math.min(h + 1, 23);
    const end = `${String(endH).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    setDrafts((d) => [...d, { key: newKey(), dayOfWeek: day, startTime: start, endTime: end }]);
  };

  const updateWindow = (key: string, patch: Partial<WindowDraft>) => {
    setDrafts((d) => d.map((w) => (w.key === key ? { ...w, ...patch } : w)));
  };

  const removeWindow = (key: string) => {
    setDrafts((d) => d.filter((w) => w.key !== key));
  };

  const save = () => {
    if (localErrors.length > 0) {
      toast.error("Please fix the highlighted rows first.");
      return;
    }
    const payload: ScheduleRow[] = drafts.map((w) => ({
      dayOfWeek: w.dayOfWeek,
      startTime: w.startTime,
      endTime: w.endTime,
    }));
    replace.mutate(payload, {
      onSuccess: () => toast.success("Schedule updated"),
      onError: (e) => toast.error(e instanceof ApiError ? e.message : "Save failed"),
    });
  };

  const reset = () => {
    if (data) setDrafts(fromRows(data));
  };

  return (
    <div>
      <div className="mb-4 rounded-xl bg-brand-50/60 border border-brand-100 p-4">
        <div className="text-sm font-medium text-brand-900">Weekly availability</div>
        <div className="text-xs text-brand-800/80 mt-0.5">
          Set the recurring windows when patients can book. Editing this template does not
          affect any appointments that are already booked.
        </div>
      </div>

      <div className="card divide-y divide-slate-100">
        {DAYS.map((d) => {
          const windows = grouped.get(d.idx) ?? [];
          return (
            <div key={d.idx} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start">
              <div className="w-28 shrink-0">
                <div className="text-sm font-semibold text-slate-900">{d.label}</div>
                <div className="text-xs text-slate-500">
                  {windows.length === 0 ? "Off" : `${windows.length} window${windows.length > 1 ? "s" : ""}`}
                </div>
              </div>
              <div className="flex-1 space-y-2">
                {windows.length === 0 ? (
                  <div className="text-xs text-slate-400 italic">No hours set for this day</div>
                ) : (
                  windows.map((w) => (
                    <div key={w.key} className="flex items-center gap-2">
                      <input
                        type="time"
                        value={w.startTime}
                        onChange={(e) => updateWindow(w.key, { startTime: e.target.value })}
                        className="input w-32"
                      />
                      <span className="text-slate-400">–</span>
                      <input
                        type="time"
                        value={w.endTime}
                        onChange={(e) => updateWindow(w.key, { endTime: e.target.value })}
                        className="input w-32"
                      />
                      <button
                        onClick={() => removeWindow(w.key)}
                        className="btn-ghost text-rose-600 hover:bg-rose-50 p-2"
                        aria-label="Remove window"
                      >
                        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M6 6l12 12M18 6L6 18" />
                        </svg>
                      </button>
                    </div>
                  ))
                )}
                <button onClick={() => addWindow(d.idx)} className="btn-ghost text-brand-700">
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                  Add window
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {localErrors.length > 0 && (
        <ul className="mt-4 space-y-1 rounded-xl bg-rose-50 border border-rose-100 px-4 py-3 text-sm text-rose-700">
          {localErrors.map((e, i) => (
            <li key={i}>• {e}</li>
          ))}
        </ul>
      )}

      <div className="mt-6 flex items-center justify-end gap-2">
        <button
          className="btn-secondary"
          onClick={reset}
          disabled={!isDirty || replace.isPending}
        >
          Discard changes
        </button>
        <button
          className="btn-primary"
          onClick={save}
          disabled={!isDirty || replace.isPending || localErrors.length > 0}
        >
          {replace.isPending && <Spinner className="h-4 w-4" />}
          Save schedule
        </button>
      </div>
    </div>
  );
}
