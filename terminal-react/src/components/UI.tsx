import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { ArrowUpRight, ArrowDownRight, Radio, WifiOff } from "lucide-react";
import { instruments, price } from "../lib/api";
export function Mark({
  symbol,
  large = false,
}: {
  symbol: string;
  large?: boolean;
}) {
  const instrument = instruments[symbol];
  return instrument ? (
    <span
      className={"asset-mark " + (large ? "large" : "")}
      title={instrument.issuer}
    >
      <img src={`/assets/instruments/${instrument.mark}.png`} alt="" />
    </span>
  ) : null;
}
export function Brand() {
  return (
    <a className="brand" href="/react/" aria-label="GEX Terminal — accueil">
      <span className="brand-emblem">
        <img
          src={import.meta.env.BASE_URL + "gex-mark.svg"}
          width="25"
          height="25"
          alt=""
        />
      </span>
      <span>
        <strong>
          GEX<span className="brand-slash">/</span>
        </strong>
        <small>TERMINAL</small>
      </span>
    </a>
  );
}
export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "positive" | "negative" | "warning";
}) {
  return <span className={"badge " + tone}>{children}</span>;
}
export function Change({ value }: { value: number | undefined }) {
  return typeof value === "number" && Number.isFinite(value) ? (
    <span className={"change " + (value < 0 ? "negative" : "positive")}>
      {value < 0 ? <ArrowDownRight size={12} /> : <ArrowUpRight size={12} />}{" "}
      {Math.abs(value).toFixed(2)} %
    </span>
  ) : (
    <span className="muted">—</span>
  );
}
export function Spark({
  values,
  tone = "positive",
}: {
  values?: number[];
  tone?: string;
}) {
  const points = values?.filter(Number.isFinite);
  if (!points || points.length < 2)
    return (
      <span className="spark-empty" aria-label="Historique non disponible" />
    );
  const min = Math.min(...points),
    max = Math.max(...points),
    span = max - min || 1;
  const coords = points
    .map(
      (v, i) =>
        `${(i / (points.length - 1)) * 120},${28 - ((v - min) / span) * 24}`,
    )
    .join(" ");
  return (
    <svg
      className={"spark " + tone}
      viewBox="0 0 120 30"
      preserveAspectRatio="none"
      aria-label="Évolution du prix observé"
      role="img"
    >
      <polyline
        points={coords}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
export function Empty({
  title,
  children,
  action,
  detail,
}: {
  detail?: string;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <WifiOff size={22} />
      <strong>{title}</strong>
      <p>{children ?? detail}</p>
      {action}
    </div>
  );
}
export function Mode({
  mode,
  connected,
}: {
  mode: string | undefined;
  connected?: boolean;
}) {
  const label =
    mode === "SIM"
      ? "Démonstration"
      : mode === "DELAYED"
        ? "Prix différé"
        : mode === "STALE"
          ? "Flux périmé"
          : mode === "DERIBIT"
            ? "Deribit"
            : mode === "RITHMIC"
              ? "Rithmic"
              : "Source en attente";
  return (
    <Badge
      tone={
        mode === "SIM" || mode === "DELAYED" || mode === "STALE"
          ? "warning"
          : connected
            ? "positive"
            : "neutral"
      }
    >
      <Radio size={11} />
      {label}
      {connected && ["DERIBIT", "RITHMIC"].includes(mode || "")
        ? " · direct"
        : ""}
    </Badge>
  );
}
export function useClock() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
export function Ohlc({
  bar,
}: {
  bar?: { open: number; high: number; low: number; close: number };
}) {
  return (
    <div className="ohlc">
      {(["open", "high", "low", "close"] as const).map((key, index) => (
        <span key={key}>
          {["O", "H", "L", "C"][index]} <b>{price(bar?.[key])}</b>
        </span>
      ))}
    </div>
  );
}
