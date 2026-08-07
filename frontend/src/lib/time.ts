import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import relativeTime from "dayjs/plugin/relativeTime";
import advancedFormat from "dayjs/plugin/advancedFormat";

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(relativeTime);
dayjs.extend(advancedFormat);

// UI-side timezone — matches the backend APP_TIMEZONE. Could be sourced
// from an API endpoint but the assignment says users + therapists share a TZ.
export const APP_TZ = "Asia/Kolkata";

export { dayjs };

export function fmtDay(iso: string): string {
  return dayjs(iso).tz(APP_TZ).format("ddd, MMM D");
}

export function fmtTime(iso: string): string {
  return dayjs(iso).tz(APP_TZ).format("h:mm A");
}

export function fmtRange(startISO: string, endISO: string): string {
  return `${fmtTime(startISO)} – ${fmtTime(endISO)}`;
}

export function fmtFull(iso: string): string {
  return dayjs(iso).tz(APP_TZ).format("ddd, MMM D · h:mm A");
}

export function groupByDay<T extends { startTime: string }>(items: T[]): {
  day: string;
  label: string;
  items: T[];
}[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = dayjs(item.startTime).tz(APP_TZ).format("YYYY-MM-DD");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, items]) => ({
      day,
      label: dayjs.tz(day, APP_TZ).format("dddd, MMMM D"),
      items,
    }));
}
