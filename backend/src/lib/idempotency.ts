import { redis, RedisKeys } from "../redis.js";
import { redlock } from "./lock.js";
import { logger } from "./logger.js";

const IDEM_TTL_SECONDS = 24 * 60 * 60;
const IDEM_LOCK_TTL_MS = 15_000;

export interface CachedResponse<T> {
  status: number;
  body: T;
}

export interface IdempotencyOutcome<T> extends CachedResponse<T> {
  fromCache: boolean;
}

/**
 * Guarantees exactly-once execution per (patientId, key) across the 3 API clusters.
 *
 * Flow:
 *   1. Fast path: read cache. If hit, return it (no lock, no work).
 *   2. Slow path: take a Redlock on `idem-lock:{patientId}:{key}` so only
 *      one cluster executes the handler for this key.
 *   3. Double-check the cache under the lock (another cluster may have
 *      finished while we were waiting).
 *   4. Execute the handler, cache the (status, body), release the lock.
 *
 * We deliberately cache the full response (status + body) so retries
 * see the *exact same* answer, including error responses. That's what
 * makes it safe for the client to retry until it hears back cleanly.
 */
export async function withIdempotency<T>(
  patientId: string,
  key: string,
  fn: () => Promise<CachedResponse<T>>
): Promise<IdempotencyOutcome<T>> {
  const cacheKey = RedisKeys.idempotency(patientId, key);
  const lockResource = `idem-lock:${patientId}:${key}`;

  const cached = await redis.get(cacheKey);
  if (cached) {
    return { ...(JSON.parse(cached) as CachedResponse<T>), fromCache: true };
  }

  const lock = await redlock.acquire([lockResource], IDEM_LOCK_TTL_MS);
  try {
    const cachedUnderLock = await redis.get(cacheKey);
    if (cachedUnderLock) {
      return {
        ...(JSON.parse(cachedUnderLock) as CachedResponse<T>),
        fromCache: true,
      };
    }

    const result = await fn();
    await redis.set(cacheKey, JSON.stringify(result), "EX", IDEM_TTL_SECONDS);
    return { ...result, fromCache: false };
  } finally {
    try {
      await lock.release();
    } catch (err) {
      logger.warn({ err, key }, "Idempotency lock release failed (harmless)");
    }
  }
}
