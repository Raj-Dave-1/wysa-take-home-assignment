import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../auth/middleware.js";
import { asyncHandler } from "../lib/errors.js";
import { getAvailability } from "./service.js";
import { todayInAppTz, dayjs, APP_TZ } from "../lib/time.js";

const router: Router = Router();

const querySchema = z.object({
  therapistId: z.string().uuid(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

router.get(
  "/",
  authenticate,
  asyncHandler(async (req, res) => {
    const parsed = querySchema.parse(req.query);
    const from = parsed.from ?? todayInAppTz();
    const to =
      parsed.to ?? dayjs.tz(from, APP_TZ).add(6, "day").format("YYYY-MM-DD");

    const requestingPatientId =
      req.user?.role === "PATIENT" ? req.user.profileId : undefined;

    const result = await getAvailability({
      therapistId: parsed.therapistId,
      fromISODate: from,
      toISODate: to,
      requestingPatientId,
    });
    res.json({ ...result, from, to });
  })
);

export default router;
