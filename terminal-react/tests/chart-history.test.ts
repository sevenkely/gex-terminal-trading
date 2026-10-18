import { it, expect } from "vitest";
import { mergeLiveHistory } from "../src/lib/chart-history";
const bar = { time: 100, open: 10, high: 12, low: 9, close: 11, volume: 50 };
it("retains the real tick close without inventing volume during a cached refresh", () => {
  expect(
    mergeLiveHistory([bar], { ...bar, high: 14, low: 8, close: 13, volume: 0 }),
  ).toEqual([{ ...bar, high: 14, low: 8, close: 13 }]);
});
it("keeps a newer real candle, but never fabricates intermediate candles", () => {
  expect(mergeLiveHistory([bar], { ...bar, time: 300, volume: 0 })).toEqual([
    bar,
    { ...bar, time: 300, volume: 0 },
  ]);
});
it("does not override newer history or restore data when the source becomes empty", () => {
  expect(mergeLiveHistory([bar], { ...bar, time: 50 })).toEqual([bar]);
  expect(mergeLiveHistory([], bar)).toEqual([]);
  expect(mergeLiveHistory([bar], null)).toEqual([bar]);
});
