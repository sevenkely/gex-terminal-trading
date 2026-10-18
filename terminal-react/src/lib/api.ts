import { QueryClient } from "@tanstack/react-query";
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal, credentials: "same-origin" });
  if (!response.ok)
    throw new ApiError(
      response.status,
      response.status === 401
        ? "Accès de lecture requis"
        : response.status === 429
          ? "Quota atteint. Réessayez dans une minute."
          : "Source indisponible (" + response.status + ")",
    );
  const value = await response.json();
  if (value.error) throw new ApiError(502, "Le fournisseur ne répond pas.");
  return value as T;
}
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (n, error) =>
        !(
          error instanceof ApiError && [401, 403, 429].includes(error.status)
        ) && n < 1,
      staleTime: 10000,
      refetchOnWindowFocus: false,
    },
  },
});
export const price = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value)
    ? new Intl.NumberFormat("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(value)
    : "—";
export function compact(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}
export const symbols = [
  "SPX",
  "ES",
  "SPY",
  "QQQ",
  "NQ",
  "GLD",
  "GC",
  "BTC",
] as const;
export const instruments: Record<
  string,
  { name: string; mark: string; issuer: string }
> = {
  SPX: { name: "S&P 500", mark: "sp-global", issuer: "Fournisseur S&P Global" },
  ES: { name: "E-mini S&P 500", mark: "cme-group", issuer: "Place CME Group" },
  SPY: {
    name: "SPDR S&P 500",
    mark: "state-street",
    issuer: "Émetteur State Street",
  },
  QQQ: { name: "Invesco QQQ", mark: "invesco", issuer: "Émetteur Invesco" },
  NQ: {
    name: "E-mini Nasdaq 100",
    mark: "cme-group",
    issuer: "Place CME Group",
  },
  GLD: {
    name: "SPDR Gold Shares",
    mark: "state-street",
    issuer: "Distributeur State Street",
  },
  GC: {
    name: "Gold futures",
    mark: "cme-group",
    issuer: "Place COMEX / CME Group",
  },
  BTC: { name: "Bitcoin", mark: "bitcoin", issuer: "Bitcoin" },
};
