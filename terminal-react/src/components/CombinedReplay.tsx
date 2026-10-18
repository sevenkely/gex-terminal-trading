import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  type Time,
} from "lightweight-charts";
import { api, price } from "../lib/api";
import { useWorkspace } from "../lib/store";
import { replayFrame, type RecordedEvent } from "../lib/replay";
import type { ReplayRow } from "../lib/types";
import { Empty } from "./UI";
const format = (t: number) => new Date(t * 1000).toISOString().slice(0, 19);
function ReplayChart({ frame }: { frame: ReturnType<typeof replayFrame> }) {
  const host = useRef<HTMLDivElement>(null),
    data = useRef<((frame: ReturnType<typeof replayFrame>) => void) | null>(
      null,
    );
  useEffect(() => {
    if (!host.current) return;
    const chart = createChart(host.current, {
      autoSize: true,
      height: 320,
      layout: { background: { color: "#101719" }, textColor: "#98aaa9" },
      grid: {
        vertLines: { color: "#202a2d" },
        horzLines: { color: "#202a2d" },
      },
      timeScale: { timeVisible: true },
    });
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: "#91d7bd",
      downColor: "#e99da4",
      borderVisible: false,
      wickUpColor: "#91d7bd",
      wickDownColor: "#e99da4",
    });
    const keys = ["call_wall", "put_wall", "zero_gex"] as const;
    const lines = keys.map((key, i) =>
      chart.addSeries(LineSeries, {
        color: ["#91d7bd", "#e99da4", "#debd7e"][i],
        title: key,
        priceLineVisible: false,
        lastValueVisible: false,
      }),
    );
    data.current = (value) => {
      candles.setData(
        value.candles.map((b) => ({ ...b, time: b.time as Time })),
      );
      keys.forEach((key, i) => {
        const points = new Map<number, number | null>();
        let previous = 0;
        for (const row of value.snapshots) {
          const time = Math.floor(row.recorded_at);
          if (previous && time - previous > 90) points.set(previous + 1, null);
          const p = row.levels[key];
          points.set(time, typeof p === "number" && p > 0 ? p : null);
          previous = time;
        }
        lines[i].setData(
          [...points]
            .sort((a, b) => a[0] - b[0])
            .map(([time, p]) =>
              p == null
                ? { time: time as Time }
                : { time: time as Time, value: p },
            ),
        );
      });
      chart.timeScale().fitContent();
    };
    return () => {
      data.current = null;
      chart.remove();
    };
  }, []);
  useEffect(() => data.current?.(frame), [frame]);
  return (
    <div
      className="combined-chart"
      data-testid="combined-replay-chart"
      ref={host}
    />
  );
}
export function CombinedReplay() {
  const symbol = useWorkspace((s) => s.symbol),
    filter = useWorkspace((s) => s.filter),
    [input, setInput] = useState(() => ({
      start: format(Date.now() / 1000 - 3600),
      end: format(Date.now() / 1000),
    })),
    [window, setWindow] = useState<{ start: number; end: number } | null>(null),
    [index, setIndex] = useState(0),
    [playing, setPlaying] = useState(false),
    [speed, setSpeed] = useState(4),
    [message, setMessage] = useState("");
  const snapshots = useQuery({
    queryKey: ["combined-snapshots", symbol, filter, window],
    enabled: !!window,
    queryFn: ({ signal }) =>
      api<{ rows: ReplayRow[] }>(
        `/api/replay/${symbol}?filter=${filter}&limit=1000&before=${window!.end}`,
        signal,
      ),
  });
  const events = useInfiniteQuery({
    queryKey: ["combined-events", symbol, window],
    enabled: !!window,
    initialPageParam: 0,
    queryFn: ({ signal, pageParam }) =>
      api<{ rows: RecordedEvent[]; has_more: boolean; next_cursor: number }>(
        `/api/replay-events/${symbol}?start=${window!.start}&end=${window!.end}&cursor=${pageParam}&limit=1000`,
        signal,
      ),
    getNextPageParam: (last) => (last.has_more ? last.next_cursor : undefined),
  });
  const recording = useQuery({
    queryKey: ["recording"],
    queryFn: ({ signal }) =>
      api<{ enabled: boolean; dropped: number; failures: number }>(
        "/api/recording",
        signal,
      ),
  });
  const received = useMemo(
    () => events.data?.pages.flatMap((p) => p.rows) || [],
    [events.data],
  );
  const rows = useMemo(
    () =>
      snapshots.data?.rows.filter(
        (r) => r.recorded_at >= (window?.start || 0),
      ) || [],
    [snapshots.data, window],
  );
  const times = useMemo(
    () =>
      [
        ...new Set([
          ...rows.map((r) => r.recorded_at),
          ...received.map((r) => r.received_at),
        ]),
      ].sort((a, b) => a - b),
    [rows, received],
  );
  const safeIndex = Math.min(index, Math.max(0, times.length - 1)),
    cursor = times[safeIndex] || 0,
    frame = useMemo(
      () => replayFrame(rows, received, cursor),
      [rows, received, cursor],
    );
  useEffect(() => {
    if (!playing) return;
    if (safeIndex >= times.length - 1) return;
    const timer = setTimeout(
      () => setIndex(safeIndex + 1),
      Math.max(1, ((times[safeIndex + 1] - cursor) * 1000) / speed),
    );
    return () => clearTimeout(timer);
  }, [playing, safeIndex, times, cursor, speed]);
  const moving = playing && safeIndex < times.length - 1;
  return (
    <>
      <p className="fine-print">
        Relecture indépendante du live : bougies de ticks prix réellement
        enregistrés, trajectoires GEX et prints reçus, avec un même curseur en
        heure de réception. Aucun historique synthétique. Jusqu’à 1 000
        snapshots ; pages d’événements chargées explicitement.
      </p>
      <form
        className="tools-controls"
        onSubmit={(e) => {
          e.preventDefault();
          const start = Date.parse(input.start + "Z") / 1000,
            end = Date.parse(input.end + "Z") / 1000;
          if (
            !(
              end > start &&
              end - start <= 86400 &&
              end <= Date.now() / 1000 + 5
            )
          ) {
            setMessage("Fenêtre UTC ordonnée, non future, de 24 h maximum.");
            return;
          }
          setMessage("");
          setPlaying(false);
          setIndex(0);
          setWindow({ start, end });
        }}
      >
        {(["start", "end"] as const).map((key) => (
          <label className="field" key={key}>
            {key === "start" ? "Début UTC" : "Fin UTC"}
            <input
              required
              aria-label={
                key === "start" ? "Début relecture UTC" : "Fin relecture UTC"
              }
              type="datetime-local"
              step={1}
              value={input[key]}
              onChange={(e) => setInput({ ...input, [key]: e.target.value })}
            />
          </label>
        ))}
        <button className="primary" type="submit">
          Charger la fenêtre
        </button>
      </form>
      {message && (
        <p role="alert" className="notice">
          {message}
        </p>
      )}
      <p className="notice">
        Enregistrement :{" "}
        {recording.data?.enabled
          ? "activé"
          : "désactivé ou statut indisponible"}
        . {recording.data?.dropped || 0} événements perdus,{" "}
        {recording.data?.failures || 0} échecs d’écriture. Respecter les droits
        de conservation ; activation via GEX_RECORD_EVENTS=true, pas de
        rattrapage tick historique.
      </p>
      {window && (snapshots.isError || events.isError) ? (
        <p className="notice" role="alert">
          Chargement incomplet.{" "}
          <button
            onClick={() => {
              void snapshots.refetch();
              void events.refetch();
            }}
          >
            Réessayer
          </button>
        </p>
      ) : window && (snapshots.isPending || events.isPending) ? (
        <p role="status">Chargement du journal…</p>
      ) : window && times.length ? (
        <>
          <div className="tools-controls">
            <button
              disabled={safeIndex === 0}
              onClick={() => {
                setPlaying(false);
                setIndex(safeIndex - 1);
              }}
            >
              Précédent
            </button>
            <button
              onClick={() => {
                if (safeIndex >= times.length - 1) setIndex(0);
                setPlaying(!moving);
              }}
            >
              {moving ? "Pause" : "Lecture"}
            </button>
            <button
              disabled={safeIndex >= times.length - 1}
              onClick={() => {
                setPlaying(false);
                setIndex(safeIndex + 1);
              }}
            >
              Suivant
            </button>
            <label className="field">
              Vitesse
              <select
                aria-label="Vitesse relecture combinée"
                value={speed}
                onChange={(e) => setSpeed(Number(e.target.value))}
              >
                {[1, 4, 16, 60].map((v) => (
                  <option key={v} value={v}>
                    {v}×
                  </option>
                ))}
              </select>
            </label>
            <span>
              {format(cursor)} UTC · {safeIndex + 1}/{times.length}
            </span>
          </div>
          <input
            className="replay-slider"
            aria-label="Curseur relecture combinée"
            type="range"
            min={0}
            max={times.length - 1}
            value={safeIndex}
            onChange={(e) => {
              setPlaying(false);
              setIndex(Number(e.target.value));
            }}
          />
          <ReplayChart frame={frame} />
          <div className="tools-metrics">
            <span>
              Ticks prix reçus<strong>{frame.priceCount}</strong>
            </span>
            <span>
              Prints options reçus<strong>{frame.optionCount}</strong>
            </span>
            <span>
              Dernier prix observé
              <strong>{price(frame.candles.at(-1)?.close)}</strong>
            </span>
            <span>
              Call / Put Wall
              <strong>
                {price(frame.latest?.levels.call_wall)} /{" "}
                {price(frame.latest?.levels.put_wall)}
              </strong>
            </span>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Réception UTC</th>
                  <th>Source UTC</th>
                  <th>Type</th>
                  <th>Contrat</th>
                  <th>Prix</th>
                  <th>Quantité source</th>
                </tr>
              </thead>
              <tbody>
                {frame.events
                  .slice(-100)
                  .reverse()
                  .map((e) => (
                    <tr key={e.id}>
                      <td>{format(e.received_at)}</td>
                      <td>{format(e.occurred_at)}</td>
                      <td>{e.kind}</td>
                      <td>{e.payload.instrument || "—"}</td>
                      <td>{price(e.payload.price ?? e.payload.price_btc)}</td>
                      <td>{e.payload.amount ?? "—"}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          {!frame.priceCount && (
            <p className="notice">
              Aucun tick prix enregistré à ce curseur : aucune bougie n’est
              fabriquée à partir des snapshots GEX.
            </p>
          )}
          <p className="fine-print">
            {events.hasNextPage
              ? "Journal partiel : des pages restent à charger."
              : "Pages de cette fenêtre chargées."}{" "}
            La couverture d’échange n’est pas certifiée. Les lignes GEX sont
            interrompues après un trou de 90 s. Les quantités restent dans leur
            unité source ; elles ne constituent pas une mesure d’absorption.
          </p>
        </>
      ) : (
        window &&
        !snapshots.isPending &&
        !events.isPending && (
          <Empty
            title="Aucune observation enregistrée dans cette fenêtre"
            detail="L'enregistrement commence seulement à son activation. Aucun passé n’est inventé."
          />
        )
      )}
      {events.hasNextPage && (
        <button
          disabled={events.isFetchingNextPage}
          onClick={() => {
            setPlaying(false);
            void events.fetchNextPage();
          }}
        >
          Charger les 1 000 événements suivants
        </button>
      )}
    </>
  );
}
