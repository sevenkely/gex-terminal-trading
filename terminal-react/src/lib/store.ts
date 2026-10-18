import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { safeRead, safeAnchors } from "./preferences";
import "../../../frontend/indicator-math.js";
import type { SymbolCode, Interval, Filter, IndicatorOptions } from "./types";
export const math = window.IndicatorMath;
const read = (key: string) => {
  try {
    return JSON.parse(safeRead(key) || "null");
  } catch {
    return null;
  }
};
export type AdvancedTab =
  | "exposure"
  | "heatmap"
  | "scenario"
  | "drawings"
  | "research"
  | "replay"
  | "alerts"
  | "sources";
interface Workspace {
  advancedTab: AdvancedTab;
  symbol: SymbolCode;
  interval: Interval;
  filter: Filter;
  source: "perp" | "options";
  motion: "rich" | "calm" | "off";
  zen: boolean;
  panel: "levels" | "flow";
  dialog: "indicators" | "journal" | "replay" | "settings" | "advanced" | null;
  indicators: IndicatorOptions;
  anchors: Record<string, { vp?: number; vwap?: number }>;
  set: (patch: Partial<Workspace>) => void;
  setSymbol: (symbol: SymbolCode) => void;
  updateIndicators: (options: IndicatorOptions) => void;
  setAnchor: (name: "vp" | "vwap", time: number) => void;
}
export const useWorkspace = create<Workspace>()(
  persist(
    (set, get) => ({
      advancedTab: "exposure",
      symbol: "BTC",
      interval: ["1m", "5m", "15m", "30m", "1h", "1d"].includes(
        safeRead("gex.chart.interval") || "",
      )
        ? (safeRead("gex.chart.interval") as Interval)
        : "5m",
      filter: "all",
      source: "perp",
      motion: "rich",
      zen: false,
      panel: "levels",
      dialog: null,
      indicators: math.sanitize(read("gex.indicators.v1")),
      anchors: safeAnchors(read("gex.indicator.anchors")),
      set: (patch) => set(patch),
      setSymbol: (symbol) => {
        const { indicators, anchors } = get();
        set({
          symbol,
          indicators: {
            ...indicators,
            vp: { ...indicators.vp, anchor: anchors[symbol]?.vp ?? null },
            vwap: { ...indicators.vwap, anchor: anchors[symbol]?.vwap ?? null },
          },
        });
      },
      updateIndicators: (options) =>
        set({ indicators: math.sanitize(options) }),
      setAnchor: (name, time) => {
        const { symbol, anchors, indicators } = get();
        set({
          anchors: {
            ...anchors,
            [symbol]: { ...anchors[symbol], [name]: time },
          },
          indicators: {
            ...indicators,
            [name]: { ...indicators[name], period: "anchored", anchor: time },
          },
        });
      },
    }),
    {
      name: "gex.react.workspace.v1",
      storage: createJSONStorage(() => ({
        getItem: safeRead,
        setItem: (key, value) => {
          try {
            localStorage.setItem(key, value);
          } catch {
            /* Preferences are optional. */
          }
        },
        removeItem: (key) => {
          try {
            localStorage.removeItem(key);
          } catch {
            /* Read-only storage. */
          }
        },
      })),
      partialize: ({ symbol, interval, motion, indicators, anchors }) => ({
        symbol,
        interval,
        motion,
        indicators,
        anchors,
      }),
      merge: (saved, current) => {
        const raw = saved as Partial<Workspace> | null;
        return {
          ...current,
          ...(raw &&
          ["SPX", "ES", "SPY", "QQQ", "NQ", "GLD", "GC", "BTC"].includes(
            raw.symbol || "",
          )
            ? { symbol: raw.symbol }
            : {}),
          interval:
            raw &&
            ["1m", "5m", "15m", "30m", "1h", "1d"].includes(raw.interval || "")
              ? raw.interval!
              : current.interval,
          motion:
            raw && ["rich", "calm", "off"].includes(raw.motion || "")
              ? raw.motion!
              : current.motion,
          indicators: math.sanitize(raw?.indicators ?? current.indicators),
          anchors: safeAnchors(raw?.anchors),
        };
      },
    },
  ),
);
