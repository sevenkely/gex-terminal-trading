import type { SymbolCode } from "./types";
export function safeRead(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function safeAnchors(raw: unknown) {
  const clean: Record<string, { vp?: number; vwap?: number }> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return clean;
  for (const symbol of [
    "SPX",
    "ES",
    "SPY",
    "QQQ",
    "NQ",
    "GLD",
    "GC",
    "BTC",
  ] as SymbolCode[]) {
    const value = (raw as Record<string, unknown>)[symbol];
    if (!value || typeof value !== "object") continue;
    for (const name of ["vp", "vwap"] as const) {
      const time = (value as Record<string, unknown>)[name];
      if (typeof time === "number" && Number.isFinite(time) && time > 0)
        clean[symbol] = { ...clean[symbol], [name]: time };
    }
  }
  return clean;
}
