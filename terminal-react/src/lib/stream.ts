import { useSyncExternalStore } from "react";
import type { Tick } from "./types";
type Snapshot = {
  context: string;
  tick: Tick | null;
  status: "connecting" | "connected" | "disconnected" | "permission";
  received: number;
};
export class MarketStream {
  private socket: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private publishTimer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private listeners = new Set<() => void>();
  private raw = new Set<(tick: Tick) => void>();
  private snapshot: Snapshot = {
    context: "",
    tick: null,
    status: "disconnected",
    received: 0,
  };
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.snapshot;
  subscribeTicks = (listener: (tick: Tick) => void) => {
    this.raw.add(listener);
    return () => {
      this.raw.delete(listener);
    };
  };
  private publish = (patch: Partial<Snapshot>) => {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  };
  connect(symbol: string, filter: string) {
    this.disconnect();
    const generation = this.generation;
    let failures = 0;
    let pending: Tick | null = null;
    const open = () => {
      if (generation !== this.generation) return;
      this.publish({
        context: symbol + "|" + filter,
        tick: null,
        status: "connecting",
        received: 0,
      });
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(
        `${protocol}//${location.host}/ws/${symbol}?filter=${filter}`,
      );
      this.socket = ws;
      ws.onmessage = (event) => {
        if (generation !== this.generation) return;
        try {
          const tick: Tick = JSON.parse(event.data);
          if (
            typeof tick.price !== "number" ||
            !Number.isFinite(tick.price) ||
            tick.price <= 0
          )
            return;
          failures = 0;
          this.raw.forEach((listener) => listener(tick));
          pending = tick;
          if (!this.publishTimer)
            this.publishTimer = setTimeout(() => {
              this.publishTimer = undefined;
              if (generation === this.generation && pending)
                this.publish({
                  tick: pending,
                  status: "connected",
                  received: Date.now(),
                });
            }, 350);
        } catch {
          /* Invalid packets never enter the chart. */
        }
      };
      ws.onclose = (event) => {
        if (generation !== this.generation) return;
        clearTimeout(this.publishTimer);
        this.publishTimer = undefined;
        if ([4401, 1008].includes(event.code)) {
          this.publish({ status: "permission" });
          return;
        }
        this.publish({ status: "disconnected" });
        this.timer = setTimeout(
          open,
          Math.min(15000, 1000 * 2 ** Math.min(failures++, 4)),
        );
      };
      ws.onerror = () => ws.close();
    };
    open();
    return () => {
      if (generation === this.generation) this.disconnect();
    };
  }
  disconnect() {
    this.generation++;
    clearTimeout(this.timer);
    clearTimeout(this.publishTimer);
    this.publishTimer = undefined;
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.close();
      this.socket = null;
    }
    this.publish({
      context: "",
      tick: null,
      status: "disconnected",
      received: 0,
    });
  }
}
export const stream = new MarketStream();
const waiting: Snapshot = {
  context: "",
  tick: null,
  status: "connecting",
  received: 0,
};
export const useMarket = (context?: string) => {
  const snapshot = useSyncExternalStore(stream.subscribe, stream.getSnapshot);
  return context && snapshot.context !== context ? waiting : snapshot;
};
