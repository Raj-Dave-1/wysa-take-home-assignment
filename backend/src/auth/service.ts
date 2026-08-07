import bcrypt from "bcryptjs";
import jwt, { type SignOptions } from "jsonwebtoken";
import { db } from "../db/index.js";
import { users, therapists, patients } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { Unauthorized } from "../lib/errors.js";
import { config } from "../config.js";

export type Role = "PATIENT" | "THERAPIST";

export interface AuthTokenPayload {
  sub: string; // user id
  role: Role;
  profileId: string; // therapist.id or patient.id
  email: string;
  name: string;
}

export async function login(email: string, password: string) {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email.toLowerCase().trim()))
    .limit(1);

  if (!user) throw Unauthorized("Invalid email or password");

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) throw Unauthorized("Invalid email or password");

  let profileId: string;
  if (user.role === "THERAPIST") {
    const [t] = await db
      .select()
      .from(therapists)
      .where(eq(therapists.userId, user.id))
      .limit(1);
    if (!t) throw Unauthorized("Therapist profile missing");
    profileId = t.id;
  } else {
    const [p] = await db
      .select()
      .from(patients)
      .where(eq(patients.userId, user.id))
      .limit(1);
    if (!p) throw Unauthorized("Patient profile missing");
    profileId = p.id;
  }

  const payload: AuthTokenPayload = {
    sub: user.id,
    role: user.role,
    profileId,
    email: user.email,
    name: user.name,
  };

  const token = jwt.sign(payload, config.JWT_SECRET, {
    expiresIn: config.JWT_EXPIRES_IN as SignOptions["expiresIn"],
    issuer: config.JWT_ISSUER,
    audience: config.JWT_AUDIENCE,
  });

  return {
    token,
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
      profileId,
    },
  };
}

export function verifyToken(token: string): AuthTokenPayload {
  try {
    return jwt.verify(token, config.JWT_SECRET, {
      issuer: config.JWT_ISSUER,
      audience: config.JWT_AUDIENCE,
    }) as AuthTokenPayload;
  } catch {
    throw Unauthorized("Invalid or expired token");
  }
}
