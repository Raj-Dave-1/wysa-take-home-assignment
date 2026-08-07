import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { config } from "../config.js";
import { logger } from "./logger.js";

export class AppError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const BadRequest = (msg: string, details?: unknown) =>
  new AppError(400, "BAD_REQUEST", msg, details);
export const Unauthorized = (msg = "Unauthorized") =>
  new AppError(401, "UNAUTHORIZED", msg);
export const Forbidden = (msg = "Forbidden") =>
  new AppError(403, "FORBIDDEN", msg);
export const NotFound = (msg = "Not found") =>
  new AppError(404, "NOT_FOUND", msg);
export const Conflict = (msg: string) => new AppError(409, "CONFLICT", msg);
export const Gone = (msg: string) => new AppError(410, "GONE", msg);

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
) {
  const reqId = (req as { id?: string }).id;

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid request",
        details: err.flatten(),
      },
    });
    return;
  }

  if (err instanceof AppError) {
    // Only 5xx AppErrors should be logged at error level; 4xx are client errors.
    if (err.status >= 500) {
      logger.error({ err, reqId }, "AppError (5xx)");
    }
    res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
    });
    return;
  }

  // Truly unexpected. Log full details server-side, respond with a
  // generic message. Never leak stack traces to clients.
  logger.error({ err, reqId }, "Unhandled error");
  const isDev = config.NODE_ENV !== "production";
  res.status(500).json({
    error: {
      code: "INTERNAL",
      message: "Internal server error",
      ...(isDev && err instanceof Error ? { details: { message: err.message } } : {}),
    },
  });
}

export function asyncHandler<T extends (...args: any[]) => Promise<any>>(fn: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
