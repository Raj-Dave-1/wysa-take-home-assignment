import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { Login } from "./routes/Login";
import { PatientDashboard } from "./routes/PatientDashboard";
import { TherapistDashboard } from "./routes/TherapistDashboard";
import { useAuthStore } from "./store/auth";

function RootRedirect() {
  const { user } = useAuthStore();
  if (!user) return <Navigate to="/login" replace />;
  return <Navigate to={user.role === "PATIENT" ? "/patient" : "/therapist"} replace />;
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route element={<Layout />}>
          <Route path="/" element={<RootRedirect />} />
          <Route
            path="/patient/*"
            element={
              <ProtectedRoute role="PATIENT">
                <PatientDashboard />
              </ProtectedRoute>
            }
          />
          <Route
            path="/therapist/*"
            element={
              <ProtectedRoute role="THERAPIST">
                <TherapistDashboard />
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<RootRedirect />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
