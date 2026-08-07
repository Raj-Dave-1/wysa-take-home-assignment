import { useState } from "react";
import { AvailabilityView } from "../features/patient/AvailabilityView";
import { HoldBanner } from "../features/patient/HoldBanner";
import { MyBookings } from "../features/patient/MyBookings";

type Tab = "availability" | "bookings";

const tabs: { id: Tab; label: string }[] = [
  { id: "availability", label: "Find a slot" },
  { id: "bookings", label: "My bookings" },
];

function initialTab(): Tab {
  const h = typeof window !== "undefined" ? window.location.hash.replace("#", "") : "";
  return h === "bookings" ? "bookings" : "availability";
}

export function PatientDashboard() {
  const [tab, setTab] = useState<Tab>(initialTab);
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900">Your care schedule</h1>
        <p className="text-sm text-slate-500 mt-1">
          Reserve a session with a therapist. Slots are held for up to 60 seconds while you confirm.
        </p>
      </div>

      <HoldBanner />

      <div className="mb-6 border-b border-slate-200">
        <nav className="-mb-px flex gap-6">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={
                "border-b-2 px-1 py-3 text-sm font-medium transition " +
                (tab === t.id
                  ? "border-brand-600 text-brand-700"
                  : "border-transparent text-slate-500 hover:text-slate-800 hover:border-slate-300")
              }
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      {tab === "availability" ? <AvailabilityView /> : <MyBookings />}
    </div>
  );
}
