import cron from "node-cron";
import { logger } from "../lib/logger.js";
import { redlock } from "../lib/lock.js";
import { extendActiveSeries } from "./service.js";

const EXTEND_LOCK_RESOURCE = "cron:extend-series";
const EXTEND_LOCK_TTL_MS = 5 * 60 * 1000;

/**
 * Runs nightly at 02:00 in the server's timezone. Extends every active
 * recurring series to keep the rolling 90-day horizon full.
 *
 * A Redlock guards the job so only ONE cluster runs it per night, even
 * though all 3 clusters have the same cron scheduled.
 */
export function startSeriesExtensionCron() {
  cron.schedule("0 2 * * *", async () => {
    try {
      await runExtensionSafely();
    } catch (err) {
      logger.error({ err }, "Series extension cron failed");
    }
  });
  logger.info("Series extension cron scheduled: '0 2 * * *'");
}

export async function runExtensionSafely() {
  let lock;
  try {
    lock = await redlock.acquire([EXTEND_LOCK_RESOURCE], EXTEND_LOCK_TTL_MS);
  } catch (err) {
    logger.info({ err }, "Extension lock not acquired — another cluster owns it");
    return { seriesProcessed: 0, appointmentsCreated: 0, skipped: true };
  }
  try {
    const result = await extendActiveSeries();
    logger.info({ result }, "Series extension complete");
    return { ...result, skipped: false };
  } finally {
    try {
      await lock.release();
    } catch (err) {
      logger.warn({ err }, "Extension lock release failed (harmless)");
    }
  }
}
