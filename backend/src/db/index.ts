import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { config } from "../config.js";
import * as schema from "./schema.js";

const { Pool } = pg;

// Neon, Render, and most managed Postgres require TLS. Detect any of:
// - NODE_ENV=production (explicit opt-in)
// - URL has `sslmode=require` (Neon default)
// - Hostname is a managed provider we know about
const url = config.DATABASE_URL;
const needsSsl =
  config.NODE_ENV === "production" ||
  url.includes("sslmode=require") ||
  url.includes(".neon.tech") ||
  url.includes(".render.com") ||
  url.includes(".supabase.co") ||
  url.includes(".aws.");

export const pool = new Pool({
  connectionString: url,
  // `rejectUnauthorized: false` accepts the provider's cert without pinning.
  // Fine for a demo; a hardened production setup would ship the CA bundle.
  ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  max: config.NODE_ENV === "production" ? 5 : 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on("error", (err) => {
  // pg emits pool-wide errors here (e.g. idle client dropped by server).
  // Log at error level but don't crash; individual queries will still surface
  // their own errors via the request path.
  console.error("[pg] pool error", err);
});

export const db = drizzle(pool, { schema });
export type DB = typeof db;
export { schema };
