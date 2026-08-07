import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16),
  JWT_EXPIRES_IN: z.string().default("7d"),
  JWT_ISSUER: z.string().default("wysa-api"),
  JWT_AUDIENCE: z.string().default("wysa-clients"),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  HOLD_TTL_SECONDS: z.coerce.number().default(60),
  RECURRING_HORIZON_DAYS: z.coerce.number().default(90),
  APP_TIMEZONE: z.string().default("Asia/Kolkata"),
  AVAILABILITY_MAX_DAYS: z.coerce.number().default(30),
  // Rate limiting (per 60 s window)
  RATE_LIMIT_GLOBAL_PER_MIN: z.coerce.number().default(300),
  RATE_LIMIT_AUTH_PER_MIN: z.coerce.number().default(10),
  RATE_LIMIT_BOOKING_PER_MIN: z.coerce.number().default(30),
  // Number of proxy hops to trust (0 = none, 1 = single reverse proxy like Render/Vercel)
  TRUST_PROXY: z.coerce.number().default(1),
  // Optional shared secret for maintenance endpoints (e.g. /series/extend).
  // If empty, those endpoints require only a valid user JWT (dev-friendly).
  ADMIN_TOKEN: z.string().min(16).optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
