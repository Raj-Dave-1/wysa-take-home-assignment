import Redlock from "redlock";
import { redis } from "../redis.js";
import { logger } from "./logger.js";

/**
 * Single-Redis Redlock. Even with one Redis node, this still provides
 * mutual exclusion across the 3 API clusters — which is exactly the
 * property the assignment cares about.
 *
 * Tuning:
 *  - retryCount 8 × retryDelay 100ms ≈ up to 800ms of contention wait
 *    before we surface a lock-acquire error to the client. Booking is
 *    interactive, so keeping the tail latency bounded matters.
 *  - driftFactor 0.01 accounts for clock skew when computing lock validity.
 */
export const redlock = new Redlock([redis], {
  driftFactor: 0.01,
  retryCount: 8,
  retryDelay: 100,
  retryJitter: 100,
  automaticExtensionThreshold: 500,
});

redlock.on("error", (err: Error & { name?: string }) => {
  // ResourceLockedError = expected retry noise, don't spam logs.
  if (err?.name === "ResourceLockedError") return;
  logger.error({ err }, "Redlock error");
});
