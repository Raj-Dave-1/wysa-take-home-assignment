import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/errors.js";
import { authLimiter } from "../lib/rateLimit.js";
import { login } from "./service.js";
import { authenticate } from "./middleware.js";

const router: Router = Router();

const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(200),
});

router.post(
  "/login",
  authLimiter,
  asyncHandler(async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    const result = await login(email, password);
    res.json(result);
  })
);

router.get(
  "/me",
  authenticate,
  asyncHandler(async (req, res) => {
    res.json({ user: req.user });
  })
);

export default router;
