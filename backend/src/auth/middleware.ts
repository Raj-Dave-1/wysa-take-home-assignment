import type { NextFunction, Request, Response } from "express";
import { verifyToken, type AuthTokenPayload, type Role } from "./service.js";
import { Forbidden, Unauthorized } from "../lib/errors.js";

declare global {
  namespace Express {
    interface Request {
      user?: AuthTokenPayload;
    }
  }
}

export function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction
) {
  const header = req.header("authorization");
  if (!header || !header.toLowerCase().startsWith("bearer ")) {
    return next(Unauthorized("Missing Bearer token"));
  }
  const token = header.slice(7).trim();
  try {
    req.user = verifyToken(token);
    return next();
  } catch (err) {
    return next(err);
  }
}

export function authorize(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(Unauthorized());
    if (!roles.includes(req.user.role)) return next(Forbidden());
    return next();
  };
}
