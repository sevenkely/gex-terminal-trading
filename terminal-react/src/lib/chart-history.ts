import type { Candle } from "./types";
const time = (bar: Candle) =>
  typeof bar.time === "number"
    ? bar.time
    : Date.parse(bar.time + "T00:00:00Z") / 1000;
/** Keep the most recently received real-price candle across a cached HTTP refresh.
 * Historical volume remains authoritative; a tick never supplies trade volume. */
export function mergeLiveHistory(
  rows: Candle[],
  live: Candle | null,
): Candle[] {
  if (!rows.length || !live) return rows;
  const end = rows[rows.length - 1];
  if (time(live) < time(end)) return rows;
  if (time(live) > time(end)) return [...rows, live];
  return [
    ...rows.slice(0, -1),
    {
      ...end,
      close: live.close,
      high: Math.max(end.high, live.high),
      low: Math.min(end.low, live.low),
    },
  ];
}
