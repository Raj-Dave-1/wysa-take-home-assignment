import { Router } from "express";
import { z } from "zod";
import { authenticate, authorize } from "../auth/middleware.js";
import { asyncHandler, Unauthorized } from "../lib/errors.js";
import {
  getOwnSchedule,
  listAssignedAppointments,
  replaceSchedule,
} from "./service.js";

const router: Router = Router();

const listQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

// Accepts both HH:MM and HH:MM:SS (Postgres `time` columns serialize with seconds).
// Always normalized to HH:MM before it reaches the service — that's the storage
// format for schedule rows and the format the frontend expects on GET.
const timeStrRegex = /^([0-1]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;
const timeStrSchema = z
  .string()
  .regex(timeStrRegex, "Expected HH:MM or HH:MM:SS")
  .transform((s) => s.slice(0, 5));

const scheduleRowSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  startTime: timeStrSchema,
  endTime: timeStrSchema,
});

const scheduleBodySchema = z.object({
  schedule: z.array(scheduleRowSchema).max(200),
});

/**
 * GET /therapist/appointments?from=&to=
 * Assigned appointments for the calling therapist, joined with patient name.
 */
router.get(
  "/appointments",
  authenticate,
  authorize("THERAPIST"),
  asyncHandler(async (req, res) => {
    if (!req.user) throw Unauthorized();
    const { from, to } = listQuerySchema.parse(req.query);
    const items = await listAssignedAppointments(req.user.profileId, {
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });
    res.json({ appointments: items });
  })
);

router.get(
  "/schedule",
  authenticate,
  authorize("THERAPIST"),
  asyncHandler(async (req, res) => {
    if (!req.user) throw Unauthorized();
    const schedule = await getOwnSchedule(req.user.profileId);
    res.json({ schedule });
  })
);

/**
 * PUT /therapist/schedule
 * Replaces the entire weekly template for the calling therapist.
 * Existing appointments are untouched by design.
 */
router.put(
  "/schedule",
  authenticate,
  authorize("THERAPIST"),
  asyncHandler(async (req, res) => {
    if (!req.user) throw Unauthorized();
    const { schedule } = scheduleBodySchema.parse(req.body);
    const result = await replaceSchedule(req.user.profileId, schedule);
    res.json(result);
  })
);

export default router;
