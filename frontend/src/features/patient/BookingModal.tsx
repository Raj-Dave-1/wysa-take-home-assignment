import { useState } from "react";
import { Modal } from "../../components/Modal";
import { Spinner } from "../../components/Spinner";
import { fmtFull, dayjs, APP_TZ } from "../../lib/time";
import { useConfirmBooking } from "./api";
import type { Frequency, Hold } from "../../types/api";
import { toast } from "../../components/Toast";
import { ApiError } from "../../lib/api";

interface Props {
  hold: Hold;
  onClose: () => void;
}

const FREQUENCIES: { value: Frequency; label: string; hint: string }[] = [
  { value: "weekly", label: "Weekly", hint: "every 7 days at this time" },
  { value: "biweekly", label: "Every 2 weeks", hint: "every 14 days at this time" },
  { value: "monthly", label: "Monthly", hint: "same day-of-month each month" },
  { value: "daily", label: "Daily", hint: "every day at this time (weekdays only if scheduled)" },
];

export function BookingModal({ hold, onClose }: Props) {
  const confirm = useConfirmBooking();
  const [mode, setMode] = useState<"one-time" | "recurring">("one-time");
  const [frequency, setFrequency] = useState<Frequency>("weekly");
  const [useEndDate, setUseEndDate] = useState(false);
  const [endDate, setEndDate] = useState(() =>
    dayjs(hold.startTime).tz(APP_TZ).add(3, "month").format("YYYY-MM-DD")
  );
  const [error, setError] = useState<string | null>(null);

  const onConfirm = () => {
    setError(null);
    const base = {
      therapistId: hold.therapistId,
      startTime: hold.startTime,
      endTime: hold.endTime,
    };
    const body =
      mode === "one-time"
        ? base
        : {
            ...base,
            recurrence: {
              frequency,
              ...(useEndDate
                ? { endDate: dayjs.tz(endDate, APP_TZ).endOf("day").toISOString() }
                : {}),
            },
          };
    confirm.mutate(body, {
      onSuccess: (res) => {
        if (mode === "one-time") {
          toast.success("Appointment booked");
        } else {
          const count = res.appointments?.length ?? 0;
          const skipped = res.skipped ?? 0;
          toast.success(
            `Series booked · ${count} appointments${skipped ? ` (${skipped} skipped)` : ""}`
          );
        }
        onClose();
      },
      onError: (e) => {
        const msg = e instanceof ApiError ? e.message : "Booking failed";
        setError(msg);
      },
    });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Confirm your booking"
      footer={
        <>
          <button className="btn-secondary" onClick={onClose} disabled={confirm.isPending}>
            Back
          </button>
          <button className="btn-primary" onClick={onConfirm} disabled={confirm.isPending}>
            {confirm.isPending ? <Spinner className="h-4 w-4" /> : null}
            {mode === "one-time" ? "Book appointment" : "Book series"}
          </button>
        </>
      }
    >
      <div className="rounded-xl bg-slate-50 border border-slate-100 px-4 py-3">
        <div className="text-xs uppercase tracking-wide text-slate-500 font-medium">
          Selected slot
        </div>
        <div className="mt-1 text-slate-900 font-medium">{fmtFull(hold.startTime)}</div>
        <div className="text-sm text-slate-500">
          {dayjs(hold.endTime).diff(dayjs(hold.startTime), "minute")} minute session
        </div>
      </div>

      <div className="mt-5">
        <div className="text-sm font-medium text-slate-700 mb-2">Type</div>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setMode("one-time")}
            className={
              "rounded-xl border px-3 py-3 text-left transition " +
              (mode === "one-time"
                ? "border-brand-500 bg-brand-50 ring-2 ring-brand-500/20"
                : "border-slate-200 bg-white hover:border-slate-300")
            }
          >
            <div className="text-sm font-medium text-slate-900">One-time</div>
            <div className="text-xs text-slate-500">Just this session</div>
          </button>
          <button
            type="button"
            onClick={() => setMode("recurring")}
            className={
              "rounded-xl border px-3 py-3 text-left transition " +
              (mode === "recurring"
                ? "border-brand-500 bg-brand-50 ring-2 ring-brand-500/20"
                : "border-slate-200 bg-white hover:border-slate-300")
            }
          >
            <div className="text-sm font-medium text-slate-900">Recurring</div>
            <div className="text-xs text-slate-500">Book a whole series</div>
          </button>
        </div>
      </div>

      {mode === "recurring" && (
        <div className="mt-5 space-y-4 animate-fade-in">
          <div>
            <div className="text-sm font-medium text-slate-700 mb-2">Frequency</div>
            <div className="space-y-2">
              {FREQUENCIES.map((f) => (
                <label
                  key={f.value}
                  className={
                    "flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2 transition " +
                    (frequency === f.value
                      ? "border-brand-500 bg-brand-50"
                      : "border-slate-200 hover:border-slate-300")
                  }
                >
                  <input
                    type="radio"
                    name="freq"
                    className="mt-1 accent-brand-600"
                    checked={frequency === f.value}
                    onChange={() => setFrequency(f.value)}
                  />
                  <div>
                    <div className="text-sm font-medium text-slate-900">{f.label}</div>
                    <div className="text-xs text-slate-500">{f.hint}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                className="accent-brand-600"
                checked={useEndDate}
                onChange={(e) => setUseEndDate(e.target.checked)}
              />
              Set an end date
            </label>
            {useEndDate && (
              <input
                type="date"
                value={endDate}
                min={dayjs(hold.startTime).tz(APP_TZ).format("YYYY-MM-DD")}
                onChange={(e) => setEndDate(e.target.value)}
                className="input mt-2"
              />
            )}
            {!useEndDate && (
              <div className="mt-1 text-xs text-slate-500">
                We'll book 90 days ahead and automatically extend.
              </div>
            )}
          </div>
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-xl bg-rose-50 border border-rose-100 px-3 py-2 text-sm text-rose-700">
          {error}
        </div>
      )}
    </Modal>
  );
}
