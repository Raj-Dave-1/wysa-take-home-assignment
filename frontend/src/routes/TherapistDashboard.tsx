import { useState } from "react";
import { AssignedAppointments } from "../features/therapist/AssignedAppointments";
import { ScheduleEditor } from "../features/therapist/ScheduleEditor";

type Tab = "appointments" | "schedule";

const tabs: { id: Tab; label: string }[] = [
  { id: "appointments", label: "Appointments" },
  { id: "schedule", label: "Weekly schedule" },
];

function initialTab(): Tab {
  const h = typeof window !== "undefined" ? window.location.hash.replace("#", "") : "";
  return h === "schedule" ? "schedule" : "appointments";
}

export function TherapistDashboard() {
  const [tab, setTab] = useState<Tab>(initialTab);
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900">Your caseload</h1>
        <p className="text-sm text-slate-500 mt-1">
          Track upcoming sessions, mark outcomes during the appointment window, and adjust
          when you're available.
        </p>
      </div>

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

      {tab === "appointments" ? <AssignedAppointments /> : <ScheduleEditor />}
    </div>
  );
}
