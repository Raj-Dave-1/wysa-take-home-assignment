import { useMemo, type Dispatch, type SetStateAction } from "react";
import { Spinner } from "../../components/Spinner";
import { APP_TZ, dayjs, fmtRange, groupByDay } from "../../lib/time";
import { toast } from "../../components/Toast";
import { ApiError } from "../../lib/api";
import {
  useAvailability,
  useCreateHold,
  useMyHold,
  useTherapists,
} from "./api";
import type { Slot, SlotStatus } from "../../types/api";

const statusPill: Record<
  SlotStatus,
  { className: string; label: string; disabled: boolean }
> = {
  available: {
    className:
      "bg-white border-slate-200 text-slate-800 hover:border-brand-500 hover:bg-brand-50 cursor-pointer",
    label: "Available",
    disabled: false,
  },
  held_by_me: {
    className:
      "bg-brand-100 border-brand-500 text-brand-800 ring-2 ring-brand-500/20",
    label: "Your hold",
    disabled: true,
  },
  held_by_other: {
    className: "bg-amber-50 border-amber-200 text-amber-700 cursor-not-allowed",
    label: "On hold",
    disabled: true,
  },
  booked: {
    className:
      "bg-slate-100 border-slate-200 text-slate-400 cursor-not-allowed",
    label: "Booked",
    disabled: true,
  },
};

interface AvailabilityViewProps {
  therapistId: string | undefined;
  setTherapistId: Dispatch<SetStateAction<string | undefined>>;
  rangeDays: number;
  setRangeDays: Dispatch<SetStateAction<number>>;
}

export function AvailabilityView({
  therapistId,
  setTherapistId,
  rangeDays,
  setRangeDays,
}: AvailabilityViewProps) {
  const { data: therapists, isLoading: therapistsLoading } = useTherapists();

  const effectiveTherapistId = therapistId ?? therapists?.[0]?.id;

  const from = useMemo(() => dayjs().tz(APP_TZ).format("YYYY-MM-DD"), []);
  const to = useMemo(
    () =>
      dayjs()
        .tz(APP_TZ)
        .add(rangeDays - 1, "day")
        .format("YYYY-MM-DD"),
    [rangeDays],
  );

  const {
    data: slots,
    isLoading: slotsLoading,
    isFetching,
    error: slotsError,
  } = useAvailability(effectiveTherapistId, from, to);
  const { data: myHold } = useMyHold();
  const createHold = useCreateHold();

  const grouped = useMemo(() => groupByDay(slots ?? []), [slots]);

  const onSlotClick = (slot: Slot) => {
    if (myHold) {
      toast.info(
        "You already have a slot on hold. Confirm or release it first.",
      );
      return;
    }
    createHold.mutate(
      {
        therapistId: slot.therapistId,
        startTime: slot.startTime,
        endTime: slot.endTime,
      },
      {
        onError: (e) =>
          toast.error(
            e instanceof ApiError ? e.message : "Could not hold slot",
          ),
      },
    );
  };

  return (
    <div>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <label className="text-sm font-medium text-slate-700">
            Therapist
          </label>
          {therapistsLoading ? (
            <Spinner className="h-4 w-4 text-slate-400" />
          ) : (
            <select
              className="input w-auto"
              value={effectiveTherapistId ?? ""}
              onChange={(e) => setTherapistId(e.target.value)}
            >
              {(therapists ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.displayName}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-slate-500">Show next</span>
          {[7, 14, 30].map((d) => (
            <button
              key={d}
              onClick={() => setRangeDays(d)}
              className={
                rangeDays === d
                  ? "rounded-full bg-brand-600 px-3 py-1 text-xs font-medium text-white"
                  : "rounded-full bg-white border border-slate-200 px-3 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
              }
            >
              {d} days
            </button>
          ))}
        </div>
      </div>

      {slotsLoading ? (
        <div className="flex items-center justify-center py-24 text-slate-400">
          <Spinner className="h-6 w-6" />
        </div>
      ) : slotsError ? (
        <div className="card p-6 text-sm text-rose-700 bg-rose-50 border-rose-100">
          Couldn't load availability: {(slotsError as Error).message}
        </div>
      ) : grouped.length === 0 ? (
        <div className="card p-10 text-center">
          <div className="text-3xl">🌤️</div>
          <div className="mt-2 text-slate-700 font-medium">No open slots</div>
          <div className="text-sm text-slate-500">
            Try extending the range or picking another therapist.
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          {grouped.map((day) => (
            <section key={day.day}>
              <h3 className="mb-3 text-sm font-semibold text-slate-500 uppercase tracking-wide">
                {day.label}
              </h3>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                {day.items.map((slot) => {
                  const p = statusPill[slot.status];
                  return (
                    <button
                      key={`${slot.startTime}-${slot.status}`}
                      disabled={p.disabled || createHold.isPending}
                      onClick={() => onSlotClick(slot)}
                      className={`rounded-xl border px-3 py-2 text-left transition ${p.className}`}
                    >
                      <div className="text-sm font-medium tabular-nums">
                        {fmtRange(slot.startTime, slot.endTime)}
                      </div>
                      <div className="mt-0.5 text-[10px] uppercase tracking-wide opacity-70">
                        {p.label}
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}

      {isFetching && !slotsLoading && (
        <div className="mt-4 flex items-center justify-center gap-2 text-xs text-slate-400">
          <Spinner className="h-3 w-3" />
          Updating…
        </div>
      )}
    </div>
  );
}
