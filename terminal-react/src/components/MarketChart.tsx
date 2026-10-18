import {
  memo,
  useEffect,
  useRef,
  useImperativeHandle,
  forwardRef,
} from "react";
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type IPriceLine,
  type AutoscaleInfo,
} from "lightweight-charts";
import { math, useWorkspace } from "../lib/store";
import { useDrawings } from "../lib/drawings";
import { stream } from "../lib/stream";
import { mergeLiveHistory } from "../lib/chart-history";
import type {
  Candle,
  Levels,
  IndicatorOptions,
  FlowBar,
  Profile,
  VwapPoint,
} from "../lib/types";
import { useInspection } from "../lib/inspection";
export interface ChartActions {
  fit: () => void;
  focusPrice: (price: number | null) => void;
  anchor: (kind: "vp" | "vwap") => void;
  tool: (
    kind: "inspect" | "hline" | "vline" | "trend" | "ray" | "rect" | "fib",
  ) => void;
  undo: () => void;
  clear: () => void;
}
interface Shape {
  id?: string;
  dash?: string;
  opacity?: number;
  fill?: number;
  color?: string;
  width?: number;
  label?: string;
  hidden?: boolean;
  locked?: boolean;
  kind: "hline" | "vline" | "trend" | "ray" | "rect" | "fib";
  a: { time: number; price: number };
  b?: { time: number; price: number };
}
const duration: Record<string, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "1d": 86400,
};
const stamp = (time: number | string) =>
  typeof time === "number" ? time : Date.parse(time + "T00:00:00Z") / 1000;
const clean = (bars: Candle[]) =>
  [
    ...new Map(
      bars
        .filter(
          (b) => Number.isFinite(b.close) && b.close > 0 && b.high >= b.low,
        )
        .map((b) => [b.time, b]),
    ).values(),
  ].sort((a, b) => stamp(a.time) - stamp(b.time));
export const MarketChart = memo(
  forwardRef<
    ChartActions,
    {
      bars: Candle[];
      baseBars: Candle[];
      options: IndicatorOptions;
      levels: Levels;
      flow: FlowBar[];
      showLevels: boolean;
      showFlow: boolean;
      onTool: (tool: string) => void;
    }
  >((props, ref) => {
    const host = useRef<HTMLDivElement>(null),
      canvas = useRef<HTMLCanvasElement>(null),
      api = useRef<IChartApi | null>(null),
      candles = useRef<ISeriesApi<"Candlestick"> | null>(null),
      volume = useRef<ISeriesApi<"Histogram"> | null>(null),
      last = useRef<Candle | null>(null),
      lines = useRef<IPriceLine[]>([]),
      latest = useRef(props),
      shapes = useRef<Shape[]>([]),
      action = useRef("inspect"),
      draft = useRef<Shape["a"] | null>(null),
      paint = useRef(() => {});
    latest.current = props;
    const focusLine = useRef<IPriceLine | null>(null);
    const fittedRef = useRef(false),
      liveBar = useRef<Candle | null>(null);
    const symbol = useWorkspace((s) => s.symbol),
      interval = useWorkspace((s) => s.interval);
    useImperativeHandle(ref, () => ({
      focusPrice: (price) => {
        const series = candles.current;
        if (!series) return;
        if (focusLine.current) {
          series.removePriceLine(focusLine.current);
          focusLine.current = null;
        }
        if (price != null && price > 0)
          focusLine.current = series.createPriceLine({
            price,
            title: "Strike sélectionné",
            color: "#debd7e",
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
          });
        series.applyOptions({
          autoscaleInfoProvider:
            price == null
              ? undefined
              : (original: () => AutoscaleInfo | null) => {
                  const info = original();
                  return info?.priceRange
                    ? {
                        ...info,
                        priceRange: {
                          minValue: Math.min(info.priceRange.minValue, price),
                          maxValue: Math.max(info.priceRange.maxValue, price),
                        },
                      }
                    : null;
                },
        });
        api.current?.priceScale("right").applyOptions({ autoScale: true });
      },
      fit: () => {
        if (focusLine.current && candles.current) {
          candles.current.removePriceLine(focusLine.current);
          focusLine.current = null;
        }
        candles.current?.applyOptions({ autoscaleInfoProvider: undefined });
        api.current?.priceScale("right").applyOptions({ autoScale: true });
        const n = latest.current.bars.length;
        api.current?.timeScale().setVisibleLogicalRange({
          from: Math.max(
            0,
            n -
              Math.max(25, Math.floor((host.current?.clientWidth || 800) / 11)),
          ),
          to: n + 4,
        });
      },
      anchor: (kind) => {
        action.current = "anchor-" + kind;
        draft.current = null;
      },
      tool: (kind) => {
        action.current = kind;
        draft.current = null;
      },
      undo: () => {
        useDrawings.getState().undo(symbol);
      },
      clear: () => {
        shapes.current = shapes.current.filter((s) => s.locked);
        saveShapes();
        paint.current();
      },
    }));
    function saveShapes() {
      useDrawings.getState().replace(symbol, [...shapes.current]);
    }
    useEffect(() => {
      if (!host.current) return;
      const chart = createChart(host.current, {
        autoSize: false,
        width: host.current.clientWidth,
        height: host.current.clientHeight,
        layout: {
          background: { color: "#101719" },
          textColor: "#889899",
          fontFamily: "IBM Plex Mono",
          fontSize: 11,
        },
        grid: {
          vertLines: { color: "#1b2426" },
          horzLines: { color: "#1b2426" },
        },
        rightPriceScale: {
          borderColor: "#293436",
          minimumWidth: 88,
          scaleMargins: { top: 0.12, bottom: 0.24 },
        },
        timeScale: {
          borderColor: "#293436",
          timeVisible: true,
          rightOffset: 5,
        },
        crosshair: {
          vertLine: { labelBackgroundColor: "#415052" },
          horzLine: { labelBackgroundColor: "#415052" },
        },
      });
      api.current = chart;
      candles.current = chart.addSeries(CandlestickSeries, {
        upColor: "#80ceba",
        downColor: "#db7e88",
        wickUpColor: "#80ceba",
        wickDownColor: "#db7e88",
        borderVisible: false,
        priceLineColor: "#9bb6b1",
        lastValueVisible: true,
      });
      volume.current = chart.addSeries(HistogramSeries, {
        priceScaleId: "volume",
        priceFormat: { type: "volume" },
        lastValueVisible: false,
        priceLineVisible: false,
      });
      chart.priceScale("volume").applyOptions({
        scaleMargins: { top: 0.83, bottom: 0.03 },
        visible: false,
      });
      let queued = false,
        frame = 0;
      fittedRef.current = false;
      let cachedBars: Candle[] | null = null,
        chartBars: Candle[] = [],
        times: number[] = [];
      let cachedBase: Candle[] | null = null,
        cachedOptions: IndicatorOptions | null = null,
        cachedRange = "",
        profileCache: (Profile | null)[] = [],
        vwapCache: VwapPoint[][] = [];
      const queue = () => {
        if (queued) return;
        queued = true;
        frame = requestAnimationFrame(() => {
          queued = false;
          draw();
        });
      };
      paint.current = queue;
      const draw = () => {
        const cv = canvas.current,
          series = candles.current;
        if (!cv || !host.current || !series) return;
        const W = host.current.clientWidth,
          H = host.current.clientHeight,
          dpr = devicePixelRatio || 1;
        if (
          cv.width !== Math.round(W * dpr) ||
          cv.height !== Math.round(H * dpr)
        ) {
          cv.width = Math.round(W * dpr);
          cv.height = Math.round(H * dpr);
        }
        const ctx = cv.getContext("2d");
        if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, W, H);
        const R = W - chart.priceScale("right").width(),
          bottom = H * 0.78;
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, R, bottom);
        ctx.clip();
        ctx.font = '10px "IBM Plex Mono"';
        const current = latest.current,
          range = chart.timeScale().getVisibleRange(),
          visible = range
            ? {
                from: stamp(range.from as number | string),
                to:
                  stamp(range.to as number | string) +
                  (duration[interval] || 300) -
                  1,
              }
            : null;
        const line = (
          price: number,
          color: string,
          label: string,
          dashed = false,
          width = 1,
          pattern = "solid",
        ) => {
          const y = series.priceToCoordinate(price);
          if (y == null || y < 14 || y > bottom) return;
          ctx.strokeStyle = color;
          ctx.lineWidth = width;
          ctx.setLineDash(
            dashed
              ? [4, 4]
              : pattern === "dashed"
                ? [8, 5]
                : pattern === "dotted"
                  ? [2, 4]
                  : [],
          );
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(R, y);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = color;
          ctx.fillText(label, Math.max(8, R - 148), y - 5);
        };
        const vp = current.options.vp,
          rangeKey = vp.period === "visible" ? JSON.stringify(visible) : "";
        if (
          cachedBase !== current.baseBars ||
          cachedOptions !== current.options ||
          cachedRange !== rangeKey
        ) {
          cachedBase = current.baseBars;
          cachedOptions = current.options;
          cachedRange = rangeKey;
          const groups = math.groups(current.baseBars, vp, symbol, visible);
          const selected =
            vp.history === "three"
              ? groups.slice(-3)
              : vp.history === "previous"
                ? groups.slice(-2, -1)
                : groups.slice(-1);
          profileCache = selected
            .map((group) => math.profile(group.bars, vp))
            .filter((p) => p && p.vol);
          vwapCache = math
            .groups(current.baseBars, current.options.vwap, symbol)
            .slice(current.options.vwap.previous ? -2 : -1)
            .map((group) => math.vwap(group.bars));
        }
        if (vp.enabled) {
          const profiles = profileCache;
          const slot =
            (R * (vp.width || 14)) / 100 / Math.max(1, profiles.length);
          profiles.forEach((profile, index) => {
            if (!profile) return;
            const left =
              vp.side === "right"
                ? R - slot * (profiles.length - index)
                : index * slot;
            for (let i = 0; i < profile.vol.length; i++) {
              const y0 = series.priceToCoordinate(
                  profile.lo + i * profile.step,
                ),
                y1 = series.priceToCoordinate(
                  profile.lo + (i + 1) * profile.step,
                );
              if (y0 == null || y1 == null) continue;
              const width = (profile.vol[i] / profile.max) * (slot - 2);
              ctx.globalAlpha = vp.opacity ?? 0.27;
              ctx.fillStyle =
                i >= profile.areaLow && i <= profile.areaHigh
                  ? vp.color
                  : vp.outside || "#6d86ab";
              ctx.fillRect(
                vp.side === "right" ? left + slot - width : left,
                Math.min(y0, y1),
                width,
                Math.max(1, Math.abs(y1 - y0) - 0.5),
              );
            }
            ctx.globalAlpha = 1;
            if (index === profiles.length - 1) {
              if (vp.poc) line(profile.poc, vp.color, "POC · VP estimé");
              if (vp.va) {
                line(profile.vah, vp.outside || vp.color, "VAH", true);
                line(profile.val, vp.outside || vp.color, "VAL", true);
              }
            }
          });
        }
        if (cachedBars !== current.bars) {
          cachedBars = current.bars;
          chartBars = clean(current.bars);
          times = chartBars.map((b) => stamp(b.time));
        }
        const xFor = (time: number) => {
          let a = 0,
            b = times.length - 1;
          while (a <= b) {
            const m = (a + b) >> 1;
            if (times[m] < time) a = m + 1;
            else b = m - 1;
          }
          if (!chartBars.length) return null;
          if (a >= times.length)
            return time < times[times.length - 1] + duration[interval]
              ? chart
                  .timeScale()
                  .timeToCoordinate(
                    chartBars[chartBars.length - 1].time as Time,
                  )
              : null;
          const x = chart
            .timeScale()
            .timeToCoordinate(chartBars[a].time as Time);
          if (a === 0 || times[a] === time) return x;
          const x0 = chart
            .timeScale()
            .timeToCoordinate(chartBars[a - 1].time as Time);
          return x == null || x0 == null
            ? null
            : x0 +
                ((x - x0) * (time - times[a - 1])) / (times[a] - times[a - 1]);
        };
        const vw = current.options.vwap;
        if (vw.enabled) {
          vwapCache.forEach((group, groupIndex) => {
            const sampled = new Map<
              number,
              { x: number; value: number; sd: number }
            >();
            group.forEach((point) => {
              if (
                visible &&
                (point.time < visible.from - 86400 || point.time > visible.to)
              )
                return;
              const x = xFor(point.time);
              if (x != null && x >= -20 && x <= R + 20)
                sampled.set(Math.round(x), { ...point, x });
            });
            const points = [...sampled.values()];
            const curve = (multiple: number) => {
              ctx.strokeStyle = vw.color;
              ctx.globalAlpha = multiple
                ? 0.28
                : groupIndex === 0 && vw.previous
                  ? 0.4
                  : 1;
              ctx.lineWidth = multiple ? 1 : vw.width;
              ctx.setLineDash(
                multiple
                  ? [3, 4]
                  : vw.style === "dashed"
                    ? [6, 4]
                    : vw.style === "dotted"
                      ? [2, 3]
                      : [],
              );
              ctx.beginPath();
              let began = false;
              for (const point of points) {
                const offset =
                    vw.bands === "percent"
                      ? (point.value * (vw.percent || 1)) / 100
                      : point.sd,
                  y = series.priceToCoordinate(point.value + multiple * offset);
                if (y == null) continue;
                if (began) ctx.lineTo(point.x, y);
                else {
                  ctx.moveTo(point.x, y);
                  began = true;
                }
              }
              ctx.stroke();
              ctx.globalAlpha = 1;
              ctx.setLineDash([]);
            };
            if (vw.bands !== "none")
              for (let n = 1; n <= (vw.bandCount || 2); n++) {
                curve(n);
                curve(-n);
              }
            curve(0);
            const p = points[points.length - 1];
            if (p && vw.labels) {
              const y = series.priceToCoordinate(p.value);
              if (y != null) {
                ctx.fillStyle = vw.color;
                ctx.fillText(
                  "VWAP · estimé",
                  Math.max(8, Math.min(R - 120, p.x - 110)),
                  y - 7,
                );
              }
            }
          });
        }
        if (current.showFlow) {
          const byBucket = new Map(
            chartBars
              .filter((b) => typeof b.time === "number")
              .map((b) => [
                Math.floor((b.time as number) / duration[interval]),
                b,
              ]),
          );
          for (const flow of current.flow) {
            const x = xFor(flow.t);
            if (x == null) continue;
            const b = byBucket.get(Math.floor(flow.t / duration[interval]));
            if (!b) continue;
            const y = series.priceToCoordinate(b.low);
            if (y == null) continue;
            if (flow.big_n > 0) {
              ctx.fillStyle = "#a2d7c9";
              ctx.beginPath();
              ctx.arc(x, y + 10, 3, 0, Math.PI * 2);
              ctx.fill();
            }
            if (flow.abs_n > 0) {
              ctx.strokeStyle = "#d6b76f";
              ctx.strokeRect(x - 4, y + 17, 8, 5);
            }
          }
        }
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "#d6b76f";
        ctx.fillStyle = "#d6b76f12";
        for (const shape of shapes.current) {
          if (shape.hidden) continue;
          ctx.lineWidth = shape.width || 1.5;
          ctx.strokeStyle = shape.color || "#d6b76f";
          ctx.fillStyle = (shape.color || "#d6b76f") + "18";
          const x = xFor(shape.a.time),
            y = series.priceToCoordinate(shape.a.price);
          if (x == null) continue;
          ctx.globalAlpha = shape.opacity ?? 1;
          ctx.setLineDash(
            shape.dash === "dashed"
              ? [8, 5]
              : shape.dash === "dotted"
                ? [2, 4]
                : [],
          );
          if (shape.kind === "vline") {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, bottom);
            ctx.stroke();
            continue;
          }
          if (y == null) continue;
          if (shape.kind === "hline") {
            line(
              shape.a.price,
              shape.color || "#d6b76f",
              shape.label || "Repère",
              false,
              shape.width || 1.5,
              shape.dash,
            );
            continue;
          }
          if (!shape.b) continue;
          const x2 = xFor(shape.b.time),
            y2 = series.priceToCoordinate(shape.b.price);
          if (x2 == null || y2 == null) continue;
          if (shape.kind === "fib") {
            const ratios = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
            for (const ratio of ratios) {
              const yy = y + (y2 - y) * ratio;
              ctx.beginPath();
              ctx.moveTo(Math.min(x, x2), yy);
              ctx.lineTo(Math.max(x, x2), yy);
              ctx.stroke();
              ctx.fillStyle = shape.color || "#d6b76f";
              ctx.fillText(
                (ratio * 100).toFixed(1) +
                  "% · " +
                  (
                    shape.a.price +
                    (shape.b.price - shape.a.price) * ratio
                  ).toFixed(2),
                Math.min(x, x2) + 4,
                yy - 3,
              );
            }
            continue;
          }
          if (shape.kind === "ray") {
            const dx = x2 - x,
              dy = y2 - y;
            if (dx === 0) {
              ctx.beginPath();
              ctx.moveTo(x, y);
              ctx.lineTo(x, bottom);
              ctx.stroke();
            } else {
              const edge = dx > 0 ? R : 0;
              ctx.beginPath();
              ctx.moveTo(x, y);
              ctx.lineTo(edge, y + (dy * (edge - x)) / dx);
              ctx.stroke();
            }
            continue;
          }
          if (shape.kind === "rect") {
            ctx.fillStyle = shape.color || "#d6b76f";
            ctx.globalAlpha = ((shape.opacity ?? 1) * (shape.fill ?? 12)) / 100;
            ctx.fillRect(
              Math.min(x, x2),
              Math.min(y, y2),
              Math.abs(x2 - x),
              Math.abs(y2 - y),
            );
            ctx.globalAlpha = shape.opacity ?? 1;
            ctx.strokeRect(
              Math.min(x, x2),
              Math.min(y, y2),
              Math.abs(x2 - x),
              Math.abs(y2 - y),
            );
          } else {
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x2, y2);
            ctx.stroke();
          }
        }
        ctx.restore();
      };
      chart.timeScale().subscribeVisibleLogicalRangeChange(queue);
      const resize = () => {
        if (host.current) {
          chart.resize(host.current.clientWidth, host.current.clientHeight);
          queue();
        }
      };
      const observer = new ResizeObserver(resize);
      window.addEventListener("resize", resize);
      observer.observe(host.current);
      let inspected = 0;
      chart.subscribeCrosshairMove((param) => {
        if (Date.now() - inspected < 90) return;
        inspected = Date.now();
        useInspection
          .getState()
          .setTime(
            param.time == null ? null : stamp(param.time as number | string),
          );
      });
      const element = host.current;
      const place = (event: MouseEvent) => {
        if (action.current === "inspect" || event.button !== 0) return;
        const bounds = element.getBoundingClientRect(),
          point = {
            x: event.clientX - bounds.left,
            y: event.clientY - bounds.top,
          };
        if (
          point.x >= bounds.width - chart.priceScale("right").width() ||
          point.y >= bounds.height * 0.8
        )
          return;
        const selectedTime = chart.timeScale().coordinateToTime(point.x);
        if (selectedTime == null) return;
        const time = stamp(selectedTime as number | string),
          price = candles.current?.coordinateToPrice(point.y);
        if (price == null) return;
        const tool = action.current;
        if (tool.startsWith("anchor-")) {
          useWorkspace
            .getState()
            .setAnchor(tool.endsWith("vp") ? "vp" : "vwap", time);
          action.current = "inspect";
          latest.current.onTool("inspect");
          return;
        }
        if (tool === "hline" || tool === "vline") {
          shapes.current = [
            ...shapes.current,
            { kind: tool, a: { time, price } },
          ];
        } else if (draft.current) {
          shapes.current = [
            ...shapes.current,
            {
              kind: tool as "trend" | "ray" | "rect" | "fib",
              a: draft.current,
              b: { time, price },
            },
          ];
          draft.current = null;
        } else {
          draft.current = { time, price };
          return;
        }
        saveShapes();
        queue();
      };
      element.addEventListener("click", place, true);
      useDrawings.getState().load(symbol);
      shapes.current = useDrawings.getState().bySymbol[symbol] || [];
      const unsubDrawings = useDrawings.subscribe((state) => {
        shapes.current = state.bySymbol[symbol] || [];
        queue();
      });
      const unsub = stream.subscribeTicks((tick) => {
        if (tick.levels) {
          for (const line of lines.current) {
            const title = line.options().title;
            const value =
              title === "Call Wall"
                ? tick.levels.call_wall
                : title === "Put Wall"
                  ? tick.levels.put_wall
                  : (tick.levels.gamma_flip ?? tick.levels.zero_gex);
            if (
              tick.data_status?.available === false ||
              tick.levels.available === false
            )
              line.applyOptions({
                lineVisible: false,
                axisLabelVisible: false,
              });
            else if (
              typeof value === "number" &&
              Number.isFinite(value) &&
              value > 0
            )
              line.applyOptions({
                price: value,
                lineVisible: latest.current.showLevels,
                axisLabelVisible: latest.current.showLevels,
              });
          }
        }
        if (
          !last.current ||
          !tick.ts ||
          !tick.price ||
          !["DERIBIT", "RITHMIC"].includes(tick.mode || "")
        )
          return;
        const time =
          interval === "1d"
            ? new Date(tick.ts * 1000).toISOString().slice(0, 10)
            : Math.floor(tick.ts / duration[interval]) * duration[interval];
        if (stamp(time) < stamp(last.current.time)) return;
        const b =
          time === last.current.time
            ? {
                ...last.current,
                close: tick.price,
                high: Math.max(last.current.high, tick.price),
                low: Math.min(last.current.low, tick.price),
              }
            : {
                time,
                open: tick.price,
                high: tick.price,
                low: tick.price,
                close: tick.price,
                volume: 0,
              };
        last.current = b;
        liveBar.current = b;
        candles.current?.update(
          b as Parameters<ISeriesApi<"Candlestick">["update"]>[0],
        );
        queue();
      });
      const key = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          action.current = "inspect";
          draft.current = null;
          latest.current.onTool("inspect");
        }
      };
      document.addEventListener("keydown", key);
      return () => {
        element.removeEventListener("click", place, true);
        observer.disconnect();
        window.removeEventListener("resize", resize);
        unsub();
        unsubDrawings();
        document.removeEventListener("keydown", key);
        cancelAnimationFrame(frame);
        chart.remove();
        api.current = null;
        candles.current = null;
        volume.current = null;
        last.current = null;
        liveBar.current = null;
        lines.current = [];
        focusLine.current = null;
        draft.current = null;

        useInspection.getState().setTime(null);
      };
      // Chart lifecycle is intentionally keyed only by instrument/timeframe, not quotes.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [symbol, interval]);
    useEffect(() => {
      const rows = mergeLiveHistory(clean(props.bars), liveBar.current);
      if (!rows.length) liveBar.current = null;
      candles.current?.setData(
        rows as Parameters<ISeriesApi<"Candlestick">["setData"]>[0],
      );
      volume.current?.setData(
        rows.map((b) => ({
          time: b.time as Time,
          value: b.volume || 0,
          color: b.close >= b.open ? "#80ceba30" : "#db7e8830",
        })),
      );
      last.current = rows[rows.length - 1] || null;
      const n = rows.length;
      if (n && !fittedRef.current) {
        fittedRef.current = true;
        api.current?.timeScale().setVisibleLogicalRange({
          from: Math.max(
            0,
            n -
              Math.max(25, Math.floor((host.current?.clientWidth || 800) / 11)),
          ),
          to: n + 4,
        });
      }
      paint.current();
    }, [props.bars, symbol, interval]);
    useEffect(() => {
      const series = candles.current;
      if (!series) return;
      lines.current.forEach((l) => series.removePriceLine(l));
      lines.current = [];
      if (props.showLevels)
        for (const [value, title, color] of [
          [props.levels.call_wall, "Call Wall", "#80ceba"],
          [props.levels.put_wall, "Put Wall", "#db7e88"],
          [
            props.levels.gamma_flip ?? props.levels.zero_gex,
            "Zero Gamma",
            "#d6b76f",
          ],
        ] as const) {
          if (typeof value === "number" && Number.isFinite(value) && value > 0)
            lines.current.push(
              series.createPriceLine({
                price: value,
                title,
                color,
                lineWidth: 1,
                lineStyle: LineStyle.Solid,
                axisLabelVisible: true,
              }),
            );
        }
      paint.current();
    }, [props.levels, props.showLevels, symbol, interval]);
    useEffect(() => {
      paint.current();
    }, [props.options, props.baseBars, props.flow, props.showFlow]);
    return (
      <div className="chart-host" ref={host} data-testid="market-chart">
        <canvas className="indicator-canvas" ref={canvas} aria-hidden="true" />
      </div>
    );
  }),
);
