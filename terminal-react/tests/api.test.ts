import { afterEach, describe, it, expect, vi } from "vitest";
import { api, ApiError, price, compact } from "../src/lib/api";
afterEach(() => vi.unstubAllGlobals());
describe("API boundary and numeric states", () => {
  it("distinguishes zero and missing values", () => {
    expect(price(0)).toBe("0.00");
    expect(price(null)).toBe("—");
    expect(price(NaN)).toBe("—");
    expect(compact(0)).toBe("0");
    expect(compact(undefined)).toBe("—");
  });
  it("surfaces permission errors without exposing credentials", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 401 }),
    );
    await expect(api("/api/symbols")).rejects.toMatchObject({ status: 401 });
  });
  it("rejects provider errors instead of inventing an empty success", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({
          ok: true,
          json: async () => ({ error: "private provider payload" }),
        }),
    );
    await expect(api("/api/history/BTC")).rejects.toBeInstanceOf(ApiError);
    await expect(api("/api/history/BTC")).rejects.not.toThrow(
      "private provider payload",
    );
  });
  it("sends cookies only to its origin and forwards cancellation", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ bars: [] }) });
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    expect(await api("/api/history/BTC", controller.signal)).toEqual({
      bars: [],
    });
    expect(fetch).toHaveBeenCalledWith("/api/history/BTC", {
      signal: controller.signal,
      credentials: "same-origin",
    });
  });
});
