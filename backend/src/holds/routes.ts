import { Router } from "express";
import { z } from "zod";
import { authenticate, authorize } from "../auth/middleware.js";
import { asyncHandler, Unauthorized } from "../lib/errors.js";
import { bookingLimiter } from "../lib/rateLimit.js";
import { acquireHold, getMyHold, releaseMyHold } from "./service.js";

const router: Router = Router();

const createSchema = z.object({
  therapistId: z.string().uuid(),
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
});

router.post(
  "/",
  authenticate,
  authorize("PATIENT"),
  bookingLimiter,
  asyncHandler(async (req, res) => {
    if (!req.user) throw Unauthorized();
    const { therapistId, startTime, endTime } = createSchema.parse(req.body);
    const hold = await acquireHold({
      patientId: req.user.profileId,
      therapistId,
      startTime: new Date(startTime),
      endTime: new Date(endTime),
    });
    res.status(201).json({ hold });
  })
);

router.get(
  "/mine",
  authenticate,
  authorize("PATIENT"),
  asyncHandler(async (req, res) => {
    if (!req.user) throw Unauthorized();
    const hold = await getMyHold(req.user.profileId);
    res.json({ hold });
  })
);

router.delete(
  "/mine",
  authenticate,
  authorize("PATIENT"),
  asyncHandler(async (req, res) => {
    if (!req.user) throw Unauthorized();
    const released = await releaseMyHold(req.user.profileId);
    res.json({ released });
  })
);

export default router;
