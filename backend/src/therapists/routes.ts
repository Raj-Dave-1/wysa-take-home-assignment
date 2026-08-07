import { Router } from "express";
import { db } from "../db/index.js";
import { therapists, schedules } from "../db/schema.js";
import { asc, eq } from "drizzle-orm";
import { authenticate } from "../auth/middleware.js";
import { asyncHandler, NotFound } from "../lib/errors.js";
import { validateParams, uuidParam } from "../lib/validate.js";

const router: Router = Router();

router.get(
  "/",
  authenticate,
  asyncHandler(async (_req, res) => {
    const rows = await db
      .select({ id: therapists.id, displayName: therapists.displayName })
      .from(therapists)
      .orderBy(asc(therapists.displayName));
    res.json({ therapists: rows });
  })
);

router.get(
  "/:id/schedule",
  authenticate,
  validateParams(uuidParam("id")),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const [t] = await db
      .select()
      .from(therapists)
      .where(eq(therapists.id, id))
      .limit(1);
    if (!t) throw NotFound("Therapist not found");

    const rows = await db
      .select({
        id: schedules.id,
        dayOfWeek: schedules.dayOfWeek,
        startTime: schedules.startTime,
        endTime: schedules.endTime,
      })
      .from(schedules)
      .where(eq(schedules.therapistId, id))
      .orderBy(asc(schedules.dayOfWeek), asc(schedules.startTime));

    res.json({
      therapist: { id: t.id, displayName: t.displayName },
      schedule: rows,
    });
  })
);

export default router;
