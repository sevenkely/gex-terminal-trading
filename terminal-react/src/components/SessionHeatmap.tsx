import { useEffect, useRef, useState } from "react";
import { useWorkspace } from "../lib/store";
import { useQuery } from "@tanstack/react-query";
import { api, compact, price } from "../lib/api";
import { Empty } from "./UI";
interface Heatmap {
  available: boolean;
  reason?: string;
  strikes: number[];
  times: number[];
  matrix: (number | null)[][];
  unit: string;
  provenance: string;
  limitation: string;
}
export function SessionHeatmap({
  focusPrice,
}: {
  focusPrice: (price: number | null) => void;
}) {
  const symbol = useWorkspace((s) => s.symbol),
    filter = useWorkspace((s) => s.filter),
    [mode, setMode] = useState("session"),
    [interval, setInterval] = useState("5m"),
    [band, setBand] = useState(".05"),
    [hover, setHover] = useState<{
      strike: number;
      time: number;
      value: number | null;
    } | null>(null),
    canvas = useRef<HTMLCanvasElement>(null);
  const query = useQuery({
    queryKey: ["session-heatmap", symbol, filter, mode, interval, band],
    queryFn: ({ signal }) =>
      api<Heatmap>(
        `/api/heatmap/${symbol}?mode=${mode}&interval=${interval}&range=${band}&filter=${filter}`,
        signal,
      ),
    refetchInterval: 120000,
  });
  const data = query.data;
  useEffect(() => {
    const cv = canvas.current;
    if (!cv || !data?.available) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const W = 1000,
      H = 48 + data.strikes.length * 19;
    cv.width = W;
    cv.height = H;
    ctx.fillStyle = "#101719";
    ctx.fillRect(0, 0, W, H);
    ctx.font = "11px IBM Plex Mono";
    const max = data.matrix.reduce(
        (maximum, row) =>
          row.reduce<number>(
            (current, value) => Math.max(current, Math.abs(value ?? 0)),
            maximum,
          ),
        1,
      ),
      cw = (W - 100) / Math.max(1, data.times.length);
    data.strikes.forEach((strike, i) => {
      ctx.fillStyle = "#98aaa9";
      ctx.fillText(price(strike), 6, 62 + i * 19);
      data.times.forEach((_, j) => {
        const value = data.matrix[j]?.[i];
        ctx.fillStyle =
          value == null
            ? "#202a2d"
            : value < 0
              ? `rgba(233,157,164,${0.08 + (0.85 * Math.abs(value)) / max})`
              : `rgba(145,215,189,${0.08 + (0.85 * Math.abs(value)) / max})`;
        ctx.fillRect(100 + j * cw, 48 + i * 19, Math.max(1, cw - 1), 18);
      });
    });
    ctx.fillStyle = "#98aaa9";
    for (
      let j = 0;
      j < data.times.length;
      j += Math.max(1, Math.floor(data.times.length / 5))
    )
      ctx.fillText(
        new Date(data.times[j] * 1000)
          .toISOString()
          .slice(5, 16)
          .replace("T", " "),
        100 + j * cw,
        28,
      );
  }, [data, query.isError, query.isPending]);
  return (
    <>
      <div className="tools-controls">
        <label className="field">
          Données
          <select
            aria-label="Mode heatmap"
            value={mode}
            onChange={(e) => {
              setMode(e.target.value);
              setHover(null);
            }}
          >
            <option value="session">Session · reconstruction indicative</option>
            <option value="hist">Snapshots enregistrés</option>
          </select>
        </label>
        <label className="field">
          Intervalle
          <select
            aria-label="Intervalle heatmap"
            value={interval}
            onChange={(e) => setInterval(e.target.value)}
          >
            {["5m", "15m", "1h"].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
        <label className="field">
          Fenêtre
          <select
            aria-label="Fenêtre heatmap"
            value={band}
            onChange={(e) => setBand(e.target.value)}
          >
            {[".03", ".05", ".10"].map((v) => (
              <option key={v} value={v}>
                ±{Number(v) * 100}%
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="notice">
        {mode === "session"
          ? "Reconstruction avec la chaîne actuelle : ce n’est PAS un historique observé du GEX."
          : "Historique des snapshots ALL réellement enregistrés, sous réserve de couverture."}
      </p>
      {query.isPending ? (
        <p role="status">Chargement de la heatmap…</p>
      ) : query.isError ? (
        <p role="alert" className="notice">
          Source heatmap indisponible.{" "}
          <button onClick={() => void query.refetch()}>Réessayer</button>
        </p>
      ) : !data?.available ? (
        <Empty
          title="Heatmap indisponible"
          detail={data?.reason || "Aucune observation."}
        />
      ) : (
        <>
          <p className="fine-print">
            {data.provenance} · unité {data.unit} USD / +1% spot ·{" "}
            {data.limitation}
          </p>
          <div className="session-heatmap-scroll">
            <canvas
              aria-label="Heatmap GEX : strikes et temps UTC. Utiliser la grille Échéances pour la navigation clavier cellule par cellule."
              ref={canvas}
              onPointerMove={(e) => {
                const bounds = e.currentTarget.getBoundingClientRect(),
                  x = ((e.clientX - bounds.left) / bounds.width) * 1000,
                  y =
                    ((e.clientY - bounds.top) / bounds.height) *
                    (48 + data.strikes.length * 19),
                  i = Math.floor((y - 48) / 19),
                  j = Math.floor(((x - 100) / 900) * data.times.length);
                if (
                  i >= 0 &&
                  i < data.strikes.length &&
                  j >= 0 &&
                  j < data.times.length
                )
                  setHover({
                    strike: data.strikes[i],
                    time: data.times[j],
                    value: data.matrix[j]?.[i] ?? null,
                  });
              }}
            />
          </div>
          <div className="method-note">
            <p>
              {hover
                ? `${price(hover.strike)} · ${new Date(hover.time * 1000).toISOString()} · ${hover.value == null ? "inconnu" : compact(hover.value) + " " + data.unit + " USD / +1% spot"}`
                : "Survolez la heatmap pour lire une observation."}
            </p>
            {hover && (
              <button onClick={() => focusPrice(hover.strike)}>
                Voir le strike
              </button>
            )}
          </div>
        </>
      )}
    </>
  );
}
