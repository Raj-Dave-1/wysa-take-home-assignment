import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { patientKeys, useMyHold, useReleaseHold } from "./api";
import { fmtFull } from "../../lib/time";
import { Spinner } from "../../components/Spinner";
import { BookingModal } from "./BookingModal";
import { toast } from "../../components/Toast";
import { ApiError } from "../../lib/api";

export function HoldBanner() {
  const qc = useQueryClient();
  const { data: hold, isLoading } = useMyHold();
  const release = useReleaseHold();
  const [now, setNow] = useState(Date.now());
  const [modalOpen, setModalOpen] = useState(false);

  useEffect(() => {
    if (!hold) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [hold?.expiresAt]);

  const remaining = useMemo(() => {
    if (!hold) return 0;
    return Math.max(0, Math.ceil((new Date(hold.expiresAt).getTime() - now) / 1000));
  }, [hold, now]);

  useEffect(() => {
    if (hold && remaining === 0) {
      // Refetch — server-side TTL has expired.
      qc.invalidateQueries({ queryKey: patientKeys.myHold() });
      qc.invalidateQueries({ queryKey: [...patientKeys.all, "availability"] });
    }
  }, [remaining, hold, qc]);

  if (isLoading || !hold || remaining === 0) return null;

  const pct = Math.max(0, Math.min(100, (remaining / 60) * 100));
  const urgency =
    remaining <= 10 ? "bg-rose-500" : remaining <= 25 ? "bg-amber-500" : "bg-brand-500";

  return (
    <>
      <div className="sticky top-16 z-20 -mx-6 mb-6 border-y border-brand-200 bg-brand-50/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-6 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-brand-600 shadow-sm">
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 8v4l3 2" />
                <circle cx="12" cy="12" r="9" />
              </svg>
            </div>
            <div>
              <div className="text-sm font-medium text-slate-900">
                You're holding {fmtFull(hold.startTime)}
              </div>
              <div className="text-xs text-slate-600">
                Confirm within{" "}
                <span className="font-semibold tabular-nums">{remaining}s</span> or the slot
                returns to everyone
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() =>
                release.mutate(undefined, {
                  onSuccess: () => toast.info("Hold released"),
                  onError: (e) =>
                    toast.error(e instanceof ApiError ? e.message : "Release failed"),
                })
              }
              disabled={release.isPending}
              className="btn-secondary"
            >
              Release
            </button>
            <button
              onClick={() => setModalOpen(true)}
              className="btn-primary"
            >
              {release.isPending ? <Spinner className="h-4 w-4" /> : null}
              Confirm booking
            </button>
          </div>
        </div>
        <div className="h-1 w-full bg-brand-100">
          <div
            className={`h-full transition-all duration-1000 ${urgency}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
      {modalOpen && (
        <BookingModal hold={hold} onClose={() => setModalOpen(false)} />
      )}
    </>
  );
}
