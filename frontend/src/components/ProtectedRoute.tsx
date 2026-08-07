import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuthStore, type Role } from "../store/auth";

interface Props {
  role?: Role;
  children: ReactNode;
}

export function ProtectedRoute({ role, children }: Props) {
  const { token, user } = useAuthStore();
  if (!token || !user) return <Navigate to="/login" replace />;
  if (role && user.role !== role) {
    return <Navigate to={user.role === "PATIENT" ? "/patient" : "/therapist"} replace />;
  }
  return <>{children}</>;
}
