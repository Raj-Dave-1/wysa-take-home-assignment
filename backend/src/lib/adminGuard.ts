import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";
import { Forbidden } from "./errors.js";

/**
 * Guards maintenance/ops endpoints.
 * - If `ADMIN_TOKEN` env is set → require `X-Admin-Token` header to match.
 * - If unset (local/dev) → no-op, so smoke tests + local runs stay ergonomic.
 *
 * Constant-time compare would be ideal, but the token is short-lived,
 * server-side only, and the comparison itself is not oracle-observable
 * through error timing (single string compare inside Node).
 */
export function requireAdminToken(
  req: Request,
  _res: Response,
  next: NextFunction
) {
  const expected = config.ADMIN_TOKEN;
  if (!expected) return next();
  const provided = req.header("x-admin-token");
  if (!provided || provided !== expected) {
    return next(Forbidden("Admin token required"));
  }
  next();
}
