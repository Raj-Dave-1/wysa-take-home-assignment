import { dayjs } from "../lib/time.js";

export type Frequency = "daily" | "weekly" | "biweekly" | "monthly";

export interface Occurrence {
  start: Date;
  end: Date;
}

/**
 * Enumerate every occurrence in [anchorStart, horizonEndInclusive].
 *
 * Design note: to avoid month-arithmetic drift (Jan 31 → Feb 28 → Mar 28),
 * every occurrence is computed as `anchor.add(i, unit)` — never by
 * incrementing a moving cursor. This keeps monthly recurrences aligned
 * to the original day-of-month whenever possible.
 */
export function enumerateOccurrences(
  anchorStart: Date,
  anchorEnd: Date,
  frequency: Frequency,
  horizonEndInclusive: Date
): Occurrence[] {
  const duration = anchorEnd.getTime() - anchorStart.getTime();
  const horizon = dayjs(horizonEndInclusive);
  const anchor = dayjs(anchorStart);

  const out: Occurrence[] = [];
  const MAX_ITER = 4000; // safety cap for pathological inputs
  for (let i = 0; i < MAX_ITER; i++) {
    const start = advance(anchor, i, frequency).toDate();
    if (dayjs(start).isAfter(horizon)) break;
    out.push({ start, end: new Date(start.getTime() + duration) });
  }
  return out;
}

function advance(
  anchor: ReturnType<typeof dayjs>,
  i: number,
  frequency: Frequency
): ReturnType<typeof dayjs> {
  switch (frequency) {
    case "daily":
      return anchor.add(i, "day");
    case "weekly":
      return anchor.add(i, "week");
    case "biweekly":
      return anchor.add(i * 2, "week");
    case "monthly":
      return anchor.add(i, "month");
  }
}
