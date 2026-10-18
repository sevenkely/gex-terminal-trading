import type { Candle, ReplayRow } from "./types";
export interface RecordedEvent {
  id: number;
  kind: string;
  occurred_at: number;
  received_at: number;
  payload: {
    price?: number;
    mode?: string;
    amount?: number;
    price_btc?: number;
    index_price?: number;
    instrument?: string;
    premium_usd?: number;
  };
}
/** The cursor is a receipt-time boundary: source timestamps never reveal future receipts. */
export function replayFrame(
  snapshots: ReplayRow[],
  events: RecordedEvent[],
  cursor: number,
  step = 60,
) {
  const known = snapshots
    .filter((s) => s.recorded_at <= cursor)
    .sort((a, b) => a.recorded_at - b.recorded_at);
  const received = events.filter(
    (e) => e.received_at <= cursor && e.occurred_at <= cursor,
  );
  const prices = received
    .filter(
      (e) =>
        e.kind === "price" &&
        ["DERIBIT", "RITHMIC"].includes(e.payload.mode || "") &&
        Number.isFinite(e.payload.price) &&
        (e.payload.price || 0) > 0,
    )
    .sort((a, b) => a.occurred_at - b.occurred_at || a.id - b.id);
  const map = new Map<number, Candle>();
  for (const event of prices) {
    const time = Math.floor(event.occurred_at / step) * step,
      p = event.payload.price!;
    const row = map.get(time);
    map.set(
      time,
      row
        ? {
            ...row,
            close: p,
            high: Math.max(row.high, p),
            low: Math.min(row.low, p),
          }
        : { time, open: p, high: p, low: p, close: p, volume: 0 },
    );
  }
  const options = received.filter((e) => e.kind === "option_trade");
  return {
    snapshots: known,
    latest: known.at(-1),
    candles: [...map.values()],
    events: received,
    optionCount: options.length,
    priceCount: prices.length,
  };
}
