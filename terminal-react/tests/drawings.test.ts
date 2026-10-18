import { it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  sanitizeDrawings,
  legacyDrawings,
  useDrawings,
} from "../src/lib/drawings";
const line = { kind: "hline", a: { time: 100, price: 5000 } };
beforeEach(() => {
  const memory = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => memory.get(k) || null,
    setItem: (k: string, v: string) => memory.set(k, v),
  });
  useDrawings.setState({ bySymbol: {}, history: {}, future: {} });
});
afterEach(() => vi.unstubAllGlobals());
it("validates geometry, styles, bounds and corrupt saved rows", () => {
  const rows = sanitizeDrawings([
    null,
    {},
    line,
    { kind: "trend", a: line.a },
    { ...line, width: 50, color: "url(javascript:x)", opacity: 5, fill: -1 },
  ]);
  expect(rows).toHaveLength(2);
  expect(rows[1]).toMatchObject({
    width: 8,
    color: "#d6b76f",
    opacity: 1,
    fill: 0,
  });
  expect(sanitizeDrawings(Array(150).fill(line))).toHaveLength(100);
});
it("keeps all six tools and converts old date anchors without mutating originals", () => {
  const raw = [
    {
      tool: "ray",
      pts: [
        { t: "2026-10-01", p: 5 },
        { t: { year: 2026, month: 10, day: 2 }, p: 6 },
      ],
      color: "#aabbcc",
      locked: true,
    },
  ];
  const copy = JSON.stringify(raw),
    result = legacyDrawings(raw);
  expect(result[0]).toMatchObject({
    kind: "ray",
    color: "#aabbcc",
    locked: true,
    a: { time: 1790812800, price: 5 },
  });
  expect(JSON.stringify(raw)).toBe(copy);
  expect(
    sanitizeDrawings(
      ["hline", "vline", "trend", "ray", "rect", "fib"].map((kind) => ({
        kind,
        a: line.a,
        b: { time: 200, price: 6000 },
      })),
    ),
  ).toHaveLength(6);
});
it("updates chart subscriptions and persists per-symbol undo/redo", () => {
  const listener = vi.fn(),
    off = useDrawings.subscribe(listener);
  const store = useDrawings.getState();
  store.load("BTC");
  store.replace("BTC", [line]);
  const first = useDrawings.getState().bySymbol.BTC[0];
  store.replace("BTC", [
    { ...first, color: "#0000ff", a: { time: 100, price: 5500 } },
  ]);
  store.load("SPX");
  expect(useDrawings.getState().bySymbol.SPX).toEqual([]);
  store.undo("BTC");
  expect(useDrawings.getState().bySymbol.BTC[0].a.price).toBe(5000);
  store.redo("BTC");
  expect(useDrawings.getState().bySymbol.BTC[0].color).toBe("#0000ff");
  expect(
    JSON.parse(localStorage.getItem("gex.react.draw.BTC") || "[]")[0].a.price,
  ).toBe(5500);
  expect(listener).toHaveBeenCalled();
  off();
});
