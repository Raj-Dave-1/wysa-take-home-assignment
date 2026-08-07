import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export type Role = "PATIENT" | "THERAPIST";

export interface AuthUser {
  id: string;
  email: string;
  role: Role;
  name: string;
  profileId: string;
}

interface AuthState {
  token: string | null;
  user: AuthUser | null;
  login: (token: string, user: AuthUser) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      login: (token, user) => set({ token, user }),
      logout: () => set({ token: null, user: null }),
    }),
    {
      name: "wysa.auth",
      storage: createJSONStorage(() => localStorage),
    }
  )
);
