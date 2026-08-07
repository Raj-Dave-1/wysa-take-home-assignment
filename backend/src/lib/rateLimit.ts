import rateLimit, { type Options } from "express-rate-limit";
import type { Request } from "express";
import { config } from "../config.js";

// Consistent JSON error envelope for 429s (matches errorHandler shape).
const rateLimitHandler: Options["handler"] = (_req, res, _next, options) => {
  res.status(options.statusCode).json({
    error: {
      code: "RATE_LIMITED",
      message: options.message ?? "Too many requests, please slow down",
    },
  });
};

/** Global limiter — a safety net across all endpoints. */
export const globalLimiter = rateLimit({
  windowMs: 60_000,
  limit: config.RATE_LIMIT_GLOBAL_PER_MIN,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: rateLimitHandler,
});

/**
 * Auth limiter — keyed by client IP (default keyGenerator).
 * Aimed at password-brute-force scenarios; the limit is deliberately low.
 */
export const authLimiter = rateLimit({
  windowMs: 60_000,
  limit: config.RATE_LIMIT_AUTH_PER_MIN,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: rateLimitHandler,
  message: "Too many login attempts, try again shortly",
});

/**
 * Booking limiter — keyed by authenticated user (profileId), falls back to IP.
 * Applied to mutating booking/hold endpoints. Must be mounted AFTER
 * `authenticate` so `req.user` is populated.
 */
export const bookingLimiter = rateLimit({
  windowMs: 60_000,
  limit: config.RATE_LIMIT_BOOKING_PER_MIN,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const uid = req.user?.profileId;
    return uid ? `u:${uid}` : `ip:${req.ip ?? "unknown"}`;
  },
  handler: rateLimitHandler,
});
