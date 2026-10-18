export type SymbolCode =
  | "SPX"
  | "ES"
  | "SPY"
  | "QQQ"
  | "NQ"
  | "GLD"
  | "GC"
  | "BTC";
export type Interval = "1m" | "5m" | "15m" | "30m" | "1h" | "1d";
export type Filter = "all" | "0dte" | "weekly" | "monthly";
export interface Candle {
  time: number | string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
export interface Instrument {
  symbol: SymbolCode;
  price: number;
  change_pct: number;
  mode: string;
  spark?: number[];
}
export interface Meta {
  available?: boolean;
  spot?: number;
  prev_close?: number;
  mode?: string;
  chain_age_seconds?: number;
  chain_ts_epoch?: number;
  oi_reference?: string;
  filtered_contracts?: number;
  filtered_oi?: number;
  gex_source?: string;
  projection?: { fresh: boolean };
  price_ts?: number;
}
export interface Levels {
  call_wall?: number | null;
  put_wall?: number | null;
  zero_gex?: number | null;
  gamma_flip?: number | null;
  net_gex_total?: number | null;
  regime?: string;
  em_up?: number;
  em_down?: number;
  spot?: number;
  available?: boolean;
}
export interface Gex extends Levels {
  symbol: SymbolCode;
  meta: Meta;
  strikes?: number[];
  net_gex?: number[];
  call_oi?: number[];
  put_oi?: number[];
}
export interface Tick {
  type?: string;
  price?: number;
  mode?: string;
  ts?: number;
  change_pct?: number;
  levels?: Levels;
  data_status?: Meta;
}
export interface FlowBar {
  t: number;
  big_n: number;
  big_total: number;
  big_buy?: number;
  big_sell?: number;
  big_unknown?: number;
  abs_n: number;
  abs_buy: number;
  abs_sell: number;
  delta: number;
  cvd?: number;
}
export interface FlowData {
  available: boolean;
  bars: FlowBar[];
  unit: string;
  contract?: string;
  exchange?: string;
  first_observed_ts?: number;
  reason?: string;
  diagnostics?: Record<string, unknown>;
}
export interface ReplayRow {
  recorded_at: number;
  chain_ts: number;
  symbol: string;
  price_mode: string;
  price: number;
  levels: Levels;
}
export interface IndicatorConfig {
  enabled: boolean;
  period: "daily" | "weekly" | "monthly" | "visible" | "anchored";
  session: "auto" | "day" | "rth" | "eth";
  zone: string;
  anchor: number | null;
  history?: "current" | "previous" | "three";
  resolution?: "rows" | "step";
  rows?: number;
  step?: number;
  valueArea?: number;
  side?: "left" | "right";
  width: number;
  opacity?: number;
  color: string;
  outside?: string;
  poc?: boolean;
  va?: boolean;
  previous?: boolean;
  bands?: "none" | "sigma" | "percent";
  bandCount?: number;
  percent?: number;
  style?: "solid" | "dashed" | "dotted";
  labels?: boolean;
}
export interface IndicatorOptions {
  base: Exclude<Interval, "1d">;
  version: number;
  vp: IndicatorConfig;
  vwap: IndicatorConfig;
}
export interface Profile {
  lo: number;
  step: number;
  vol: number[];
  total: number;
  max: number;
  poc: number;
  vah: number;
  val: number;
  areaLow: number;
  areaHigh: number;
  period?: string;
  error?: string;
}
export interface VwapPoint {
  time: number;
  value: number;
  sd: number;
}
export interface IndicatorMath {
  sanitize: (raw: unknown) => IndicatorOptions;
  normalize: (rows: Candle[]) => Candle[];
  groups: (
    rows: Candle[],
    config: IndicatorConfig,
    symbol: string,
    range?: { from: number; to: number } | null,
  ) => { period: string; bars: Candle[] }[];
  profile: (rows: Candle[], config: IndicatorConfig) => Profile | null;
  vwap: (rows: Candle[]) => VwapPoint[];
}
declare global {
  interface Window {
    IndicatorMath: IndicatorMath;
  }
}
