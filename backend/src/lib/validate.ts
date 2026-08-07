import type { NextFunction, Request, Response } from "express";
import { z, type ZodType } from "zod";

/**
 * Express middleware that validates `req.params` against a Zod schema.
 * Rejects non-UUID/malformed ids before they reach a service that would
 * otherwise perform an unnecessary DB query.
 */
export function validateParams<T extends ZodType>(schema: T) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.params);
    if (!parsed.success) return next(parsed.error);
    // Replace params with the parsed (and coerced) values.
    Object.assign(req.params, parsed.data);
    next();
  };
}

export const uuidParam = (name = "id") =>
  z.object({ [name]: z.string().uuid() });
