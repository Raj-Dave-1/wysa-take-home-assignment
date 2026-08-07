import { Router } from "express";
import { authenticate, authorize } from "../auth/middleware.js";
import { asyncHandler, Unauthorized } from "../lib/errors.js";
import { validateParams, uuidParam } from "../lib/validate.js";
import { requireAdminToken } from "../lib/adminGuard.js";
import {
  cancelSeries,
  extendActiveSeries,
  listPatientSeries,
} from "./service.js";

const router: Router = Router();

router.get(
  "/",
  authenticate,
  authorize("PATIENT"),
  asyncHandler(async (req, res) => {
    if (!req.user) throw Unauthorized();
    const rows = await listPatientSeries(req.user.profileId);
    res.json({ series: rows });
  })
);

router.delete(
  "/:id",
  authenticate,
  authorize("PATIENT"),
  validateParams(uuidParam("id")),
  asyncHandler(async (req, res) => {
    if (!req.user) throw Unauthorized();
    const result = await cancelSeries({
      patientId: req.user.profileId,
      seriesId: req.params.id,
    });
    res.json(result);
  })
);

/**
 * POST /series/extend — maintenance endpoint used by the nightly cron and
 * ops. Guarded by an optional shared admin token (see `requireAdminToken`).
 * In production, set ADMIN_TOKEN to lock this down.
 */
router.post(
  "/extend",
  authenticate,
  requireAdminToken,
  asyncHandler(async (_req, res) => {
    const result = await extendActiveSeries();
    res.json(result);
  })
);

export default router;
