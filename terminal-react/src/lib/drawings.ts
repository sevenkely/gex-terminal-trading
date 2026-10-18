import { create } from "zustand";
import { safeRead } from "./preferences";
export interface Drawing {
  id: string;
  kind: "hline" | "vline" | "trend" | "ray" | "rect" | "fib";
  a: { time: number; price: number };
  b?: { time: number; price: number };
  color: string;
  width: number;
  dash: "solid" | "dashed" | "dotted";
  opacity: number;
  fill: number;
  label: string;
  hidden: boolean;
  locked: boolean;
}
const point = (v: unknown): v is Drawing["a"] =>
  !!v &&
  typeof v === "object" &&
  Number.isFinite((v as Drawing["a"]).time) &&
  Number.isFinite((v as Drawing["a"]).price) &&
  (v as Drawing["a"]).time > 0 &&
  (v as Drawing["a"]).price > 0;
export function sanitizeDrawings(raw: unknown): Drawing[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .flatMap((v) => {
      if (
        !v ||
        !["hline", "vline", "trend", "ray", "rect", "fib"].includes(v.kind) ||
        !point(v.a) ||
        (!["hline", "vline"].includes(v.kind) && !point(v.b))
      )
        return [];
      return [
        {
          id: typeof v.id === "string" ? v.id : crypto.randomUUID(),
          kind: v.kind,
          a: { ...v.a },
          ...(v.b ? { b: { ...v.b } } : {}),
          color:
            typeof v.color === "string" && /^#[\da-f]{6}$/i.test(v.color)
              ? v.color
              : "#d6b76f",
          width: Number.isFinite(v.width)
            ? Math.max(1, Math.min(8, v.width))
            : 1.5,
          dash: ["solid", "dashed", "dotted"].includes(v.dash)
            ? v.dash
            : "solid",
          opacity: Number.isFinite(v.opacity)
            ? Math.max(0.05, Math.min(1, v.opacity))
            : 1,
          fill: Number.isFinite(v.fill)
            ? Math.max(0, Math.min(100, v.fill))
            : 12,
          label: typeof v.label === "string" ? v.label.slice(0, 60) : "Repère",
          hidden: v.hidden === true,
          locked: v.locked === true,
        },
      ];
    })
    .slice(-100);
}
interface Drawings {
  bySymbol: Record<string, Drawing[]>;
  history: Record<string, Drawing[][]>;
  future: Record<string, Drawing[][]>;
  redo: (symbol: string) => void;
  load: (symbol: string) => void;
  replace: (symbol: string, shapes: unknown) => void;
  undo: (symbol: string) => void;
}
function save(symbol: string, shapes: Drawing[]) {
  try {
    localStorage.setItem("gex.react.draw." + symbol, JSON.stringify(shapes));
  } catch {
    /* Analysis works without storage. */
  }
}
export const useDrawings = create<Drawings>((set, get) => ({
  bySymbol: {},
  history: {},
  future: {},
  redo: (symbol) => {
    const state = get(),
      future = state.future[symbol] || [],
      next = future.at(-1);
    if (!next) return;
    set((s) => ({
      bySymbol: { ...s.bySymbol, [symbol]: next },
      history: {
        ...s.history,
        [symbol]: [...(s.history[symbol] || []), s.bySymbol[symbol] || []],
      },
      future: { ...s.future, [symbol]: future.slice(0, -1) },
    }));
    save(symbol, next);
  },
  load: (symbol) => {
    if (get().bySymbol[symbol]) return;
    let raw: unknown;
    try {
      raw = JSON.parse(safeRead("gex.react.draw." + symbol) || "[]");
    } catch {
      raw = [];
    }
    set((s) => ({
      bySymbol: { ...s.bySymbol, [symbol]: sanitizeDrawings(raw) },
    }));
  },
  replace: (symbol, raw) => {
    const shapes = sanitizeDrawings(raw);
    set((s) => ({
      bySymbol: { ...s.bySymbol, [symbol]: shapes },
      future: { ...s.future, [symbol]: [] },
      history: {
        ...s.history,
        [symbol]: [
          ...(s.history[symbol] || []),
          s.bySymbol[symbol] || [],
        ].slice(-50),
      },
    }));
    save(symbol, shapes);
  },
  undo: (symbol) => {
    const state = get(),
      history = state.history[symbol] || [],
      previous = history.at(-1);
    if (!previous) return;
    set((s) => ({
      bySymbol: { ...s.bySymbol, [symbol]: previous },
      future: {
        ...s.future,
        [symbol]: [...(s.future[symbol] || []), s.bySymbol[symbol] || []],
      },
      history: { ...s.history, [symbol]: history.slice(0, -1) },
    }));
    save(symbol, previous);
  },
}));

/** Copy legacy annotations without modifying their original storage key. */
export function legacyDrawings(raw: unknown): Drawing[] {
  if (!Array.isArray(raw)) return [];
  const stamp = (t: unknown) =>
    typeof t === "number"
      ? t
      : typeof t === "string"
        ? Date.parse(t + "T00:00:00Z") / 1000
        : t && typeof t === "object"
          ? Date.UTC(
              (t as { year: number }).year,
              (t as { month: number }).month - 1,
              (t as { day: number }).day,
            ) / 1000
          : NaN;
  return sanitizeDrawings(
    raw
      .filter((s) => s && Array.isArray(s.pts))
      .map((s) => ({
        ...s,
        id: crypto.randomUUID(),
        kind: s.tool,
        a: { time: stamp(s.pts[0]?.t), price: s.pts[0]?.p },
        ...(s.pts[1]
          ? { b: { time: stamp(s.pts[1].t), price: s.pts[1].p } }
          : {}),
      })),
  );
}
