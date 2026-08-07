import { Router } from "express";
import { z } from "zod";
import { authenticate, authorize } from "../auth/middleware.js";
import { asyncHandler, BadRequest, Unauthorized } from "../lib/errors.js";
import { withIdempotency } from "../lib/idempotency.js";
import { bookingLimiter } from "../lib/rateLimit.js";
import { validateParams, uuidParam } from "../lib/validate.js";
import {
  bookOneTimeAppointment,
  cancelAppointmentInstance,
  listPatientAppointments,
  updateAppointmentStatusByTherapist,
} from "./service.js";
import { bookRecurringSeries } from "../series/service.js";

const router: Router = Router();

// Idempotency-Key must be URL-safe and reasonably sized.
const idempotencyKeyRegex = /^[A-Za-z0-9._~:-]{8,128}$/;

const createSchema = z.object({
  therapistId: z.string().uuid(),
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  recurrence: z
    .object({
      frequency: z.enum(["daily", "weekly", "biweekly", "monthly"]),
      endDate: z.string().datetime().optional(),
    })
    .optional(),
});

const listQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

/**
 * POST /appointments
 * Required header: Idempotency-Key
 *
 * Confirms the caller's active hold as a one-time appointment.
 * On repeat with same key, returns the cached response.
 */
router.post(
  "/",
  authenticate,
  authorize("PATIENT"),
  bookingLimiter,
  asyncHandler(async (req, res) => {
    if (!req.user) throw Unauthorized();
    const idemKey = req.header("Idempotency-Key");
    if (!idemKey || !idempotencyKeyRegex.test(idemKey)) {
      throw BadRequest(
        "Idempotency-Key header required (8-128 chars, [A-Za-z0-9._~:-])"
      );
    }

    const { therapistId, startTime, endTime, recurrence } = createSchema.parse(
      req.body
    );

    const outcome = await withIdempotency<Record<string, unknown>>(
      req.user.profileId,
      idemKey,
      async () => {
        try {
          if (recurrence) {
            const result = await bookRecurringSeries({
              patientId: req.user!.profileId,
              therapistId,
              anchorStart: new Date(startTime),
              anchorEnd: new Date(endTime),
              frequency: recurrence.frequency,
              endDate: recurrence.endDate ? new Date(recurrence.endDate) : undefined,
            });
            return {
              status: 201,
              body: {
                series: result.series,
                appointments: result.appointments.map((a) => ({
                  id: a.id,
                  patientId: a.patientId,
                  therapistId: a.therapistId,
                  startTime: a.startTime.toISOString(),
                  endTime: a.endTime.toISOString(),
                  status: a.status,
                  seriesId: a.seriesId,
                })),
                skipped: result.skipped,
                horizonEnd: result.horizonEnd,
              },
            };
          }

          const appt = await bookOneTimeAppointment({
            patientId: req.user!.profileId,
            therapistId,
            startTime: new Date(startTime),
            endTime: new Date(endTime),
          });
          return { status: 201, body: { appointment: appt } };
        } catch (err) {
          const anyErr = err as {
            status?: number;
            code?: string;
            message?: string;
            details?: unknown;
          };
          if (typeof anyErr?.status === "number") {
            return {
              status: anyErr.status,
              body: {
                error: {
                  code: anyErr.code ?? "ERROR",
                  message: anyErr.message ?? "Booking failed",
                  ...(anyErr.details ? { details: anyErr.details } : {}),
                },
              },
            };
          }
          throw err;
        }
      }
    );

    if (outcome.fromCache) res.setHeader("Idempotent-Replay", "true");
    res.status(outcome.status).json(outcome.body);
  })
);

router.get(
  "/",
  authenticate,
  authorize("PATIENT"),
  asyncHandler(async (req, res) => {
    if (!req.user) throw Unauthorized();
    const { from, to } = listQuerySchema.parse(req.query);
    const items = await listPatientAppointments(req.user.profileId, {
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });
    res.json({ appointments: items });
  })
);

const patchStatusSchema = z.object({
  status: z.enum(["completed", "no_show", "cancelled"]),
});

/**
 * PATCH /appointments/:id/status
 * Therapist-only. Sets terminal status during the appointment window.
 */
router.patch(
  "/:id/status",
  authenticate,
  authorize("THERAPIST"),
  validateParams(uuidParam("id")),
  asyncHandler(async (req, res) => {
    if (!req.user) throw Unauthorized();
    const { status } = patchStatusSchema.parse(req.body);
    const updated = await updateAppointmentStatusByTherapist({
      therapistId: req.user.profileId,
      appointmentId: req.params.id,
      newStatus: status,
    });
    res.json({ appointment: updated });
  })
);

/**
 * DELETE /appointments/:id
 * Cancels a single one-time appointment instance. For series-scoped
 * cancellations, see the Phase 4 endpoints.
 */
router.delete(
  "/:id",
  authenticate,
  authorize("PATIENT"),
  validateParams(uuidParam("id")),
  asyncHandler(async (req, res) => {
    if (!req.user) throw Unauthorized();
    const updated = await cancelAppointmentInstance({
      patientId: req.user.profileId,
      appointmentId: req.params.id,
    });
    res.json({ appointment: updated });
  })
);

export default router;
