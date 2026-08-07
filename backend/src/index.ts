import express from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { logger } from "./lib/logger.js";
import { errorHandler } from "./lib/errors.js";
import { globalLimiter } from "./lib/rateLimit.js";
import { pool } from "./db/index.js";
import { redis } from "./redis.js";
import authRoutes from "./auth/routes.js";
import therapistRoutes from "./therapists/routes.js";
import availabilityRoutes from "./availability/routes.js";
import holdsRoutes from "./holds/routes.js";
import appointmentsRoutes from "./appointments/routes.js";
import seriesRoutes from "./series/routes.js";
import therapistSelfRoutes from "./therapist/routes.js";
import { startSeriesExtensionCron } from "./series/cron.js";

const app = express();

// Behind reverse proxies (Render/Vercel/Nginx) so req.ip resolves to
// the real client — critical for correct rate-limit keying.
app.set("trust proxy", config.TRUST_PROXY);

// Baseline security headers. Helmet's defaults are sensible for an API
// (X-Content-Type-Options, X-Frame-Options, HSTS in prod, etc.).
// Cross-origin resource policy is loosened because the SPA is on a
// different origin than the API.
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

const allowedOrigins = config.CORS_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean);
app.use(
  cors({
    origin: allowedOrigins,
    credentials: false,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key", "X-Admin-Token"],
    exposedHeaders: ["Idempotent-Replay", "RateLimit-Remaining", "Retry-After"],
    maxAge: 600,
  })
);

app.use(express.json({ limit: "100kb" }));

app.use(
  pinoHttp({
    logger,
    // Reuse the incoming X-Request-ID or generate one; correlates
    // structured log entries with client-side telemetry.
    genReqId: (req, res) => {
      const existing = req.headers["x-request-id"];
      const id = (typeof existing === "string" && existing) || randomUUID();
      res.setHeader("X-Request-ID", id);
      return id;
    },
    // Silence access logs for the noisy health check to keep prod logs tidy.
    autoLogging: {
      ignore: (req) => req.url === "/health",
    },
    // Log 5xx at error level, 4xx at warn — everything else at info.
    customLogLevel: (_req, res, err) => {
      if (err) return "error";
      if (res.statusCode >= 500) return "error";
      if (res.statusCode >= 400) return "warn";
      return "info";
    },
  })
);

app.use(globalLimiter);

app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.use("/auth", authRoutes);
app.use("/therapists", therapistRoutes);
app.use("/availability", availabilityRoutes);
app.use("/holds", holdsRoutes);
app.use("/appointments", appointmentsRoutes);
app.use("/series", seriesRoutes);
app.use("/therapist", therapistSelfRoutes);

app.use((_req, res) => {
  res.status(404).json({ error: { code: "NOT_FOUND", message: "Not found" } });
});

app.use(errorHandler);

const server = app.listen(config.PORT, () => {
  logger.info(
    {
      port: config.PORT,
      env: config.NODE_ENV,
      trustProxy: config.TRUST_PROXY,
      cors: allowedOrigins,
      adminTokenSet: Boolean(config.ADMIN_TOKEN),
    },
    "Wysa backend listening"
  );
  startSeriesExtensionCron();
});

// Graceful shutdown — Render/PaaS providers send SIGTERM then SIGKILL after
// ~30 s. Draining the HTTP server and closing pool + redis avoids in-flight
// request drops and orphaned DB connections.
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Graceful shutdown starting");

  const forceExitTimer = setTimeout(() => {
    logger.error("Shutdown timeout — forcing exit");
    process.exit(1);
  }, 15_000);
  forceExitTimer.unref();

  server.close((err) => {
    if (err) logger.error({ err }, "HTTP server close error");
    else logger.info("HTTP server closed");
  });

  try {
    await redis.quit();
    logger.info("Redis client closed");
  } catch (err) {
    logger.warn({ err }, "Redis close error");
  }
  try {
    await pool.end();
    logger.info("Postgres pool ended");
  } catch (err) {
    logger.warn({ err }, "Postgres pool close error");
  }

  clearTimeout(forceExitTimer);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "uncaughtException");
  void shutdown("uncaughtException");
});
process.on("unhandledRejection", (reason) => {
  logger.fatal({ reason }, "unhandledRejection");
  void shutdown("unhandledRejection");
});
