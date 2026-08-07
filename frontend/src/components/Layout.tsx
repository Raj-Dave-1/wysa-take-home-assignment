import { Link, Outlet, useNavigate } from "react-router-dom";
import { useAuthStore } from "../store/auth";

export function Layout() {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <Link to="/" className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-600 text-white">
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
                <path d="M12 2a10 10 0 100 20 10 10 0 000-20zm0 4a2.5 2.5 0 110 5 2.5 2.5 0 010-5zm5 12a5 5 0 01-10 0v-.5h10v.5z" />
              </svg>
            </div>
            <div>
              <div className="text-base font-semibold text-slate-900 leading-none">Wysa</div>
              <div className="text-xs text-slate-500 leading-tight">Appointments</div>
            </div>
          </Link>
          {user && (
            <div className="flex items-center gap-4">
              <div className="text-right">
                <div className="text-sm font-medium text-slate-900">{user.name}</div>
                <div className="text-xs text-slate-500">
                  {user.role === "PATIENT" ? "Patient" : "Therapist"}
                </div>
              </div>
              <button
                onClick={() => {
                  logout();
                  navigate("/login", { replace: true });
                }}
                className="btn-secondary"
              >
                Log out
              </button>
            </div>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
}
