import { it, expect } from "vitest";
import { replayFrame, type RecordedEvent } from "../src/lib/replay";
const event = (
  id: number,
  time: number,
  received: number,
  price = 100,
): RecordedEvent => ({
  id,
  kind: "price",
  occurred_at: time,
  received_at: received,
  payload: { price, mode: "DERIBIT" },
});
it("does not leak future receipts even when source timestamps are older", () => {
  const frame = replayFrame(
    [],
    [event(1, 100, 101), event(2, 90, 200, 9000)],
    150,
  );
  expect(frame.priceCount).toBe(1);
  expect(frame.candles[0].close).toBe(100);
});
it("builds OHLC from recorded ticks only, skips gaps and rejects SIM prices", () => {
  const frame = replayFrame(
    [],
    [
      event(1, 100, 101, 100),
      event(2, 105, 106, 105),
      event(3, 102, 107, 95),
      event(4, 300, 301, 110),
      { ...event(5, 400, 401), payload: { price: 999, mode: "SIM" } },
    ],
    500,
  );
  expect(frame.candles).toEqual([
    { time: 60, open: 100, high: 105, low: 95, close: 105, volume: 0 },
    { time: 300, open: 110, high: 110, low: 110, close: 110, volume: 0 },
  ]);
});
it("keeps GEX and option prints on the same receipt cursor", () => {
  const snapshots = [
    {
      recorded_at: 100,
      chain_ts: 99,
      symbol: "BTC",
      price_mode: "DERIBIT",
      price: 100,
      levels: { call_wall: 110 },
    },
    {
      recorded_at: 200,
      chain_ts: 199,
      symbol: "BTC",
      price_mode: "DERIBIT",
      price: 200,
      levels: { call_wall: 210 },
    },
  ];
  const events = [
    { ...event(1, 90, 95), kind: "option_trade" },
    event(2, 101, 102),
  ];
  const frame = replayFrame(snapshots, events, 150);
  expect(frame.latest?.levels.call_wall).toBe(110);
  expect(frame.snapshots).toHaveLength(1);
  expect(frame.optionCount).toBe(1);
  expect(replayFrame(snapshots, events, 50).candles).toEqual([]);
});
