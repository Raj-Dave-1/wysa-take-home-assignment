import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import customParseFormat from "dayjs/plugin/customParseFormat.js";
import isSameOrAfter from "dayjs/plugin/isSameOrAfter.js";
import isSameOrBefore from "dayjs/plugin/isSameOrBefore.js";
import { config } from "../config.js";

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);
dayjs.extend(isSameOrAfter);
dayjs.extend(isSameOrBefore);

export const APP_TZ = config.APP_TIMEZONE;

export { dayjs };

/**
 * Combine a calendar date (YYYY-MM-DD) with a time-of-day (HH:mm or HH:mm:ss)
 * in the app timezone and return a UTC Date.
 */
export function combineDateAndTimeInAppTz(
  dateISO: string,
  timeHHmm: string
): Date {
  const normalized = timeHHmm.length === 5 ? timeHHmm : timeHHmm.slice(0, 5);
  return dayjs
    .tz(`${dateISO} ${normalized}`, "YYYY-MM-DD HH:mm", APP_TZ)
    .toDate();
}

export function dayOfWeekInAppTz(date: Date | string): number {
  return dayjs.tz(date, APP_TZ).day();
}

export function todayInAppTz(): string {
  return dayjs().tz(APP_TZ).format("YYYY-MM-DD");
}

export function isoDatesBetween(fromISO: string, toISO: string): string[] {
  const out: string[] = [];
  let cur = dayjs.tz(fromISO, APP_TZ).startOf("day");
  const end = dayjs.tz(toISO, APP_TZ).startOf("day");
  while (cur.isSameOrBefore(end, "day")) {
    out.push(cur.format("YYYY-MM-DD"));
    cur = cur.add(1, "day");
  }
  return out;
}
