import { useState, type FormEvent } from "react";
import { useNavigate, Navigate } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { useAuthStore, type AuthUser } from "../store/auth";
import { Spinner } from "../components/Spinner";

interface LoginResponse {
  token: string;
  user: AuthUser;
}

const DEMO_ACCOUNTS = [
  { label: "Patient", email: "patient@test.com" },
  { label: "Patient B", email: "patient2@test.com" },
  { label: "Dr. Tanuj", email: "therapist@test.com" },
  { label: "Dr. Maya", email: "therapist2@test.com" },
];

export function Login() {
  const navigate = useNavigate();
  const { token, user, login } = useAuthStore();
  const [email, setEmail] = useState("patient@test.com");
  const [password, setPassword] = useState("123456");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (token && user) {
    return <Navigate to={user.role === "PATIENT" ? "/patient" : "/therapist"} replace />;
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<LoginResponse>("/auth/login", {
        method: "POST",
        body: { email, password },
      });
      login(res.token, res.user);
      navigate(res.user.role === "PATIENT" ? "/patient" : "/therapist", {
        replace: true,
      });
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Login failed";
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-brand-50 via-slate-50 to-brand-100 px-6">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-600 text-white shadow-lg">
            <svg viewBox="0 0 24 24" className="h-8 w-8" fill="currentColor">
              <path d="M12 2a10 10 0 100 20 10 10 0 000-20zm0 4a2.5 2.5 0 110 5 2.5 2.5 0 010-5zm5 12a5 5 0 01-10 0v-.5h10v.5z" />
            </svg>
          </div>
          <h1 className="mt-4 text-2xl font-semibold text-slate-900">Welcome to Wysa</h1>
          <p className="mt-1 text-sm text-slate-500">Sign in to manage appointments</p>
        </div>

        <form onSubmit={onSubmit} className="card p-6 animate-fade-in">
          <label className="block">
            <span className="text-sm font-medium text-slate-700">Email</span>
            <input
              type="email"
              className="input mt-1"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
          </label>
          <label className="mt-4 block">
            <span className="text-sm font-medium text-slate-700">Password</span>
            <input
              type="password"
              className="input mt-1"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>

          {error && (
            <div className="mt-4 rounded-xl bg-rose-50 border border-rose-100 px-3 py-2 text-sm text-rose-700">
              {error}
            </div>
          )}

          <button type="submit" disabled={busy} className="btn-primary mt-5 w-full">
            {busy ? <Spinner className="h-4 w-4" /> : null}
            {busy ? "Signing in…" : "Sign in"}
          </button>

          <div className="mt-6 border-t border-slate-100 pt-4">
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">
              Demo accounts
            </div>
            <div className="flex flex-wrap gap-2">
              {DEMO_ACCOUNTS.map((a) => (
                <button
                  key={a.email}
                  type="button"
                  onClick={() => {
                    setEmail(a.email);
                    setPassword("123456");
                  }}
                  className="btn-ghost text-xs"
                >
                  {a.label}
                </button>
              ))}
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
