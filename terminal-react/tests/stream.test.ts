import { afterEach, beforeEach, it, expect, vi } from "vitest";
import { MarketStream } from "../src/lib/stream";
class Socket {
  static all: Socket[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor(public url: string) {
    Socket.all.push(this);
  }
  message(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}
let stream: MarketStream;
beforeEach(() => {
  vi.useFakeTimers();
  Socket.all = [];
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("location", { protocol: "https:", host: "terminal.example" });
  stream = new MarketStream();
});
afterEach(() => {
  stream.disconnect();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("uses same-origin wss and batches React notifications, not raw chart ticks", () => {
  const raw = vi.fn(),
    listener = vi.fn();
  stream.subscribeTicks(raw);
  stream.subscribe(listener);
  stream.connect("BTC", "0dte");
  expect(Socket.all[0].url).toBe("wss://terminal.example/ws/BTC?filter=0dte");
  Socket.all[0].message({ price: 100 });
  Socket.all[0].message({ price: 101 });
  expect(raw).toHaveBeenCalledTimes(2);
  expect(stream.getSnapshot().tick).toBe(null);
  vi.advanceTimersByTime(350);
  expect(stream.getSnapshot().tick?.price).toBe(101);
  expect(stream.getSnapshot().status).toBe("connected");
});
it("rejects invalid packets and isolates an old instrument", () => {
  stream.connect("SPX", "all");
  const old = Socket.all[0];
  stream.connect("BTC", "all");
  old.message({ price: 999999 });
  Socket.all[1].message({ price: -1 });
  Socket.all[1].message({ price: 100 });
  vi.advanceTimersByTime(350);
  expect(stream.getSnapshot().tick?.price).toBe(100);
  expect(old.close).toHaveBeenCalled();
});
it("reconnects with backoff, cancels reconnect on cleanup", () => {
  stream.connect("BTC", "all");
  Socket.all[0].onclose?.({ code: 1006 });
  vi.advanceTimersByTime(1000);
  expect(Socket.all.length).toBe(2);
  Socket.all[1].onclose?.({ code: 1006 });
  stream.disconnect();
  vi.advanceTimersByTime(30000);
  expect(Socket.all.length).toBe(2);
});
it("does not reconnect on a permission refusal", () => {
  stream.connect("BTC", "all");
  Socket.all[0].onclose?.({ code: 4401 });
  expect(stream.getSnapshot().status).toBe("permission");
  vi.advanceTimersByTime(60000);
  expect(Socket.all.length).toBe(1);
});
