import Redis from "ioredis";
import { config } from "./config.js";
import { logger } from "./lib/logger.js";

// ioredis auto-detects TLS from `rediss://` URLs (Upstash, Elasticache with
// in-transit encryption, etc.). No extra options needed for that.
export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 3,
  lazyConnect: false,
  enableReadyCheck: true,
  // Slightly higher retry cap for prod cold starts.
  retryStrategy: (times) => Math.min(times * 200, 2_000),
});

redis.on("error", (err) => {
  logger.error({ err }, "Redis error");
});

redis.on("connect", () => {
  logger.info("Redis connected");
});

/**
 * Atomically acquire a hold across the 3 backend clusters.
 * Semantics:
 *  - Reject if the caller (patient) already has any active hold
 *  - Reject if the slot key is already held by someone else
 *  - On success, atomically set both the slot key and the reverse patient key
 *    with matching TTL so the two never drift apart.
 *
 * Return codes:
 *   1  = acquired
 *   0  = slot already held (someone else has it)
 *  -1  = patient already has a hold
 */
redis.defineCommand("acquireHold", {
  numberOfKeys: 2,
  lua: `
    local slotKey = KEYS[1]
    local patientKey = KEYS[2]
    local patientId = ARGV[1]
    local ttl = tonumber(ARGV[2])
    local reverseValue = ARGV[3]

    if redis.call('EXISTS', patientKey) == 1 then
      return -1
    end
    local ok = redis.call('SET', slotKey, patientId, 'NX', 'EX', ttl)
    if not ok then
      return 0
    end
    redis.call('SET', patientKey, reverseValue, 'EX', ttl)
    return 1
  `,
});

/**
 * Atomically release a hold, but only if the caller actually owns the slot key.
 * Guards against a race where the TTL expired and another patient grabbed it
 * before this DELETE arrives.
 *
 * Return codes:
 *   1 = released
 *   0 = not the owner (nothing to do)
 */
redis.defineCommand("releaseHold", {
  numberOfKeys: 2,
  lua: `
    local slotKey = KEYS[1]
    local patientKey = KEYS[2]
    local patientId = ARGV[1]
    local owner = redis.call('GET', slotKey)
    if owner == patientId then
      redis.call('DEL', slotKey)
      redis.call('DEL', patientKey)
      return 1
    end
    return 0
  `,
});

/**
 * Consume a hold as part of booking. Verifies ownership and deletes both keys
 * atomically so we never confirm an appointment against a stale hold.
 *
 * Return codes:
 *   1 = consumed
 *   0 = not the owner (booking should be rejected)
 */
redis.defineCommand("consumeHold", {
  numberOfKeys: 2,
  lua: `
    local slotKey = KEYS[1]
    local patientKey = KEYS[2]
    local patientId = ARGV[1]
    local owner = redis.call('GET', slotKey)
    if owner == patientId then
      redis.call('DEL', slotKey)
      redis.call('DEL', patientKey)
      return 1
    end
    return 0
  `,
});

// Type augmentation for the custom commands.
declare module "ioredis" {
  interface RedisCommander<Context> {
    acquireHold(
      slotKey: string,
      patientKey: string,
      patientId: string,
      ttlSeconds: number | string,
      reverseValueJSON: string
    ): Promise<number>;
    releaseHold(
      slotKey: string,
      patientKey: string,
      patientId: string
    ): Promise<number>;
    consumeHold(
      slotKey: string,
      patientKey: string,
      patientId: string
    ): Promise<number>;
  }
}

export const RedisKeys = {
  hold: (therapistId: string, startTimeISO: string) =>
    `hold:${therapistId}:${startTimeISO}`,
  patientHold: (patientId: string) => `patient:hold:${patientId}`,
  idempotency: (patientId: string, key: string) =>
    `idem:${patientId}:${key}`,
  bookLock: (therapistId: string, startTimeISO: string) =>
    `lock:appt:${therapistId}:${startTimeISO}`,
};
