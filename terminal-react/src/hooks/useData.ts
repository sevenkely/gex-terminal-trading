import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useWorkspace } from "../lib/store";
import type {
  Instrument,
  Gex,
  Candle,
  FlowData,
  ReplayRow,
} from "../lib/types";
export const useSymbols = () =>
  useQuery({
    queryKey: ["symbols"],
    queryFn: ({ signal }) => api<Instrument[]>("/api/symbols", signal),
    refetchInterval: 30000,
  });
export function useGex() {
  const symbol = useWorkspace((s) => s.symbol),
    filter = useWorkspace((s) => s.filter);
  return useQuery({
    queryKey: ["gex", symbol, filter],
    queryFn: ({ signal }) =>
      api<Gex>(`/api/gex/${symbol}?filter=${filter}`, signal),
    refetchInterval: 30000,
  });
}
export function useHistory(base?: string) {
  const symbol = useWorkspace((s) => s.symbol),
    interval = useWorkspace((s) => s.interval),
    period = base || interval;
  return useQuery({
    queryKey: ["history", symbol, period],
    queryFn: ({ signal }) =>
      api<{ bars: Candle[] }>(
        `/api/history/${symbol}?interval=${period}`,
        signal,
      ),
    refetchInterval: 60000,
  });
}
export function useFlow() {
  const symbol = useWorkspace((s) => s.symbol),
    interval = useWorkspace((s) => s.interval),
    source = useWorkspace((s) => s.source);
  const history = useHistory();
  const first = history.data?.bars[0]?.time;
  const offset =
    interval === "1h" && typeof first === "number" && first % 3600 === 1800
      ? 1800
      : 0;
  return useQuery({
    queryKey: ["flow", symbol, interval, source, offset],
    queryFn: ({ signal }) =>
      api<FlowData>(
        `/api/flow/${symbol}/bars?interval=${interval}&src=${source}&limit=420&offset=${offset}`,
        signal,
      ),
    refetchInterval: 5000,
  });
}
export function useReplay(enabled: boolean) {
  const symbol = useWorkspace((s) => s.symbol),
    filter = useWorkspace((s) => s.filter);
  return useQuery({
    queryKey: ["replay", symbol, filter],
    queryFn: ({ signal }) =>
      api<{ rows: ReplayRow[] }>(
        `/api/replay/${symbol}?filter=${filter}&limit=300`,
        signal,
      ),
    enabled,
  });
}
