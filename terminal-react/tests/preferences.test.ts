import { it, expect, vi, afterEach } from "vitest";
import { safeRead, safeAnchors } from "../src/lib/preferences";
afterEach(() => vi.unstubAllGlobals());
it("drops malformed and cross-instrument anchor keys", () => {
  expect(
    safeAnchors({
      BTC: { vp: 100, vwap: "bad" },
      QQQ: { vwap: 200 },
      SPX: { vp: NaN },
      UNKNOWN: { vp: 999 },
    }),
  ).toEqual({ BTC: { vp: 100 }, QQQ: { vwap: 200 } });
  expect(safeAnchors(null)).toEqual({});
  expect(safeAnchors([])).toEqual({});
});
it("works with read-only or unavailable local storage", () => {
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw Error("storage blocked");
    },
  });
  expect(safeRead("key")).toBe(null);
});
