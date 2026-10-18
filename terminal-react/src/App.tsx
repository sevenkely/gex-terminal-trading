import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  lazy,
  Suspense,
} from "react";
import { MotionConfig, motion } from "motion/react";
import {
  Activity,
  ArrowUpRight,
  BookOpen,
  ChartCandlestick,
  ChevronDown,
  Command,
  Expand,
  Focus,
  History,
  Layers3,
  Minus,
  MousePointer2,
  PanelRightClose,
  Settings2,
  SlidersHorizontal,
  Square,
  TrendingUp,
  Undo2,
  Trash2,
  ArrowLeft,
} from "lucide-react";
import { useMotionPreference } from "./hooks/useMotionPreference";
import { useFlow, useGex, useHistory, useSymbols } from "./hooks/useData";
import { useWorkspace } from "./lib/store";
import { stream, useMarket } from "./lib/stream";
import {
  api,
  ApiError,
  instruments,
  price,
  queryClient,
  symbols,
} from "./lib/api";
import {
  Brand,
  Mark,
  Change,
  Mode,
  Spark,
  Empty,
  Ohlc,
  useClock,
} from "./components/UI";
import type { ChartActions } from "./components/MarketChart";
const MarketChart = lazy(() =>
  import("./components/MarketChart").then((module) => ({
    default: module.MarketChart,
  })),
);
import { Sidebar } from "./components/Sidebar";
import { Inspector } from "./components/Inspector";
import { useSourceStatus } from "./components/DataConnections";
import { WorkspaceDialog } from "./components/WorkspaceDialog";
import type { Filter, Interval } from "./lib/types";
const noBars: [] = [],
  noLevels = {};
function Topbar() {
  const now = useClock(),
    set = useWorkspace((s) => s.set);
  return (
    <header className="topbar">
      <Brand />
      <div className="breadcrumb">
        <span>Analyse de marché</span>
        <span>/</span>
        <strong>Espace principal</strong>
        <ChevronDown size={12} />
      </div>
      <div className="topbar-right">
        <span className="market-clock">
          {new Date(now).toLocaleTimeString("fr-FR", {
            timeZone: "America/New_York",
          })}
          <small>NEW YORK</small>
        </span>
        <a
          href="/classic/"
          className="classic-pill"
          title="Ouvrir l’interface classique dans un nouvel onglet"
          target="_blank"
          rel="noreferrer"
        >
          Classique <ArrowUpRight size={12} />
        </a>
        <button
          className="icon-button"
          aria-label="Préférences"
          onClick={() => set({ dialog: "settings" })}
        >
          <Settings2 size={17} />
        </button>
      </div>
    </header>
  );
}
function AssetRail() {
  const query = useSymbols(),
    selected = useWorkspace((s) => s.symbol),
    setSymbol = useWorkspace((s) => s.setSymbol);
  return (
    <nav className="asset-rail" aria-label="Actifs">
      {symbols.map((symbol) => {
        const row = query.data?.find((s) => s.symbol === symbol);
        return (
          <motion.button
            whileHover={{ y: -2 }}
            whileTap={{ scale: 0.98 }}
            className={"asset-tab " + (symbol === selected ? "selected" : "")}
            key={symbol}
            aria-label={symbol + " · " + instruments[symbol].name}
            onClick={() => setSymbol(symbol)}
            aria-pressed={symbol === selected}
          >
            <Mark symbol={symbol} />
            <span className="asset-name">
              {symbol}
              <small>{instruments[symbol].name}</small>
            </span>
            <span className="asset-quote">
              <strong>{price(row?.price)}</strong>
              <Change value={row?.change_pct} />
            </span>
            <Spark
              values={row?.spark}
              tone={row && row.change_pct < 0 ? "negative" : "positive"}
            />
            {symbol === selected && (
              <motion.span
                layoutId="asset-selection"
                className="asset-selection"
                transition={{ type: "spring", stiffness: 420, damping: 38 }}
              />
            )}
          </motion.button>
        );
      })}
    </nav>
  );
}
function Navigation() {
  const set = useWorkspace((s) => s.set);
  return (
    <nav className="side-nav" aria-label="Outils de l’espace">
      <span className="nav-monogram">
        g<span>×</span>
      </span>
      <button
        className="active"
        aria-label="Graphique principal"
        title="Graphique principal"
        onClick={() =>
          document
            .querySelector(".chart-panel")
            ?.scrollIntoView({ block: "start" })
        }
      >
        <ChartCandlestick size={20} />
      </button>
      <button
        aria-label="Niveaux et GEX"
        title="Échéances et exposition"
        onClick={() => set({ dialog: "advanced", advancedTab: "exposure" })}
      >
        <Layers3 size={20} />
      </button>
      <button
        aria-label="Flux observés"
        title="Flux observés"
        onClick={() => set({ panel: "flow", zen: false })}
      >
        <Activity size={20} />
      </button>
      <button
        aria-label="Outils avancés React"
        title="Scénarios, dessins, recherche et sources"
        onClick={() => set({ dialog: "advanced", advancedTab: "scenario" })}
      >
        <SlidersHorizontal size={19} />
      </button>
      <span className="nav-separator" />
      <button
        aria-label="Journal"
        title="Journal"
        onClick={() => set({ dialog: "journal" })}
      >
        <BookOpen size={19} />
      </button>
      <button
        aria-label="Relecture GEX"
        title="Relecture GEX"
        onClick={() => set({ dialog: "replay" })}
      >
        <History size={19} />
      </button>
      <div className="nav-bottom">
        <span className="react-label">R</span>
        <button
          aria-label="Réglages de l’espace"
          onClick={() => set({ dialog: "settings" })}
        >
          <Settings2 size={19} />
        </button>
      </div>
    </nav>
  );
}
function Quote() {
  const symbol = useWorkspace((s) => s.symbol),
    filter = useWorkspace((s) => s.filter),
    query = useGex(),
    quotes = useSymbols(),
    market = useMarket(symbol + "|" + filter);
  const row = quotes.data?.find((s) => s.symbol === symbol),
    value = market.tick?.price ?? query.data?.meta.spot ?? row?.price,
    now = useClock(),
    connected = market.status === "connected" && now - market.received < 20000,
    mode = market.tick?.mode ?? query.data?.meta.mode ?? row?.mode;
  return (
    <div className="instrument-heading">
      <Mark symbol={symbol} large />
      <div>
        <div className="instrument-title">
          <h1>{instruments[symbol].name}</h1>
          <span>{symbol === "BTC" ? "BTC / USD" : symbol}</span>
        </div>
        <div className="quote-line">
          <strong>{price(value)}</strong>
          <Change value={market.tick?.change_pct ?? row?.change_pct} />
        </div>
      </div>
      <div className="quote-status">
        <Mode mode={mode} connected={connected} />
        {!connected && ["DERIBIT", "RITHMIC"].includes(mode || "") && (
          <small>
            {market.status === "connecting"
              ? "Connexion au flux…"
              : "Flux temps réel non confirmé"}
          </small>
        )}
      </div>
    </div>
  );
}
function DataNotice() {
  const sources = useSourceStatus(),
    set = useWorkspace((s) => s.set);

  const symbol = useWorkspace((s) => s.symbol),
    filter = useWorkspace((s) => s.filter),
    query = useGex(),
    market = useMarket(symbol + "|" + filter);
  const meta = { ...query.data?.meta, ...market.tick?.data_status };
  const mode = market.tick?.mode ?? meta.mode;
  return (
    <>
      {sources.data &&
        !sources.data.demo &&
        !sources.data.ready_symbols.length && (
          <div className="notice source-warning" role="status">
            <span>
              Aucune chaîne réelle reçue. Vérifiez les sources et l’accès réseau
              ; la simulation est désactivée.
            </span>
            <button
              onClick={() =>
                set({ dialog: "advanced", advancedTab: "sources" })
              }
            >
              Diagnostic des sources
            </button>
          </div>
        )}

      <div className="data-strip">
        <span className="source-dot" />
        <span>
          {symbol === "BTC"
            ? "Options Deribit"
            : "Options CBOE différées ~15 min"}
        </span>
        <span>·</span>
        <span>
          {meta.filtered_contracts?.toLocaleString("fr-FR") ?? "—"} séries
        </span>
        <span>·</span>
        <span>
          OI{" "}
          {meta.filtered_oi?.toLocaleString("fr-FR", { notation: "compact" }) ??
            "—"}
        </span>
        <span className="data-method">GEX estimé calls + / puts −</span>
      </div>
      {mode === "SIM" ? (
        <div className="notice">
          DÉMONSTRATION — prix simulés. Non utilisables pour une décision
          réelle.
        </div>
      ) : mode === "DELAYED" || mode === "STALE" ? (
        <div className="notice">
          {mode === "STALE" ? "Flux interrompu" : "Prix différé"} — aucun prix
          temps réel confirmé. Alertes suspendues.
        </div>
      ) : null}
      {query.isError && (
        <div className="notice">
          La chaîne est indisponible. Les niveaux ne sont pas remplacés par des
          données fictives.
        </div>
      )}
    </>
  );
}
function Login() {
  const [token, setToken] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <main className="login-screen">
      <Brand />
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          try {
            const response = await fetch("/api/session", {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ token }),
            });
            if (!response.ok)
              throw Error("Jeton invalide ou session indisponible.");
            setToken("");
            await queryClient.invalidateQueries();
          } catch (error) {
            setMessage(
              error instanceof Error ? error.message : "Accès indisponible",
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        <span className="eyebrow">ACCÈS DE LECTURE</span>
        <h1>Votre espace de marché.</h1>
        <p>
          Utilisez le jeton de lecture configuré pour ce serveur. Aucun compte
          de trading n’est demandé.
        </p>
        <label className="field">
          <span>Jeton de lecture</span>
          <input
            required
            type="password"
            autoComplete="off"
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
        </label>
        <button className="primary" disabled={busy}>
          {busy ? "Ouverture…" : "Ouvrir la session"} <ArrowUpRight size={16} />
        </button>
        {message && <p role="alert">{message}</p>}
      </form>
    </main>
  );
}
export default function App() {
  const symbol = useWorkspace((s) => s.symbol),
    interval = useWorkspace((s) => s.interval),
    filter = useWorkspace((s) => s.filter),
    source = useWorkspace((s) => s.source),
    zen = useWorkspace((s) => s.zen),
    motionLevel = useWorkspace((s) => s.motion),
    options = useWorkspace((s) => s.indicators),
    set = useWorkspace((s) => s.set);
  const reduced = useMotionPreference(),
    chart = useRef<ChartActions>(null),
    [tool, setTool] = useState("inspect"),
    [showLevels, setShowLevels] = useState(true),
    [showFlow, setShowFlow] = useState(true);
  const quoteQuery = useSymbols(),
    gex = useGex(),
    history = useHistory(),
    base = useHistory(options.base),
    flow = useFlow();
  const requiresAuth =
    quoteQuery.error instanceof ApiError && quoteQuery.error.status === 401;
  useEffect(() => {
    if (requiresAuth) {
      stream.disconnect();
      return;
    }
    return stream.connect(symbol, filter);
  }, [symbol, filter, requiresAuth]);
  useEffect(() => {
    setTool("inspect");
  }, [symbol, interval]);
  useEffect(() => {
    const visibility = () => {
      document.documentElement.dataset.tabHidden = String(document.hidden);
    };
    visibility();
    document.addEventListener("visibilitychange", visibility);
    return () => document.removeEventListener("visibilitychange", visibility);
  }, []);
  const onTool = useCallback((tool: string) => setTool(tool), []);
  const levels = useMemo(
    () =>
      gex.isError ||
      gex.data?.available === false ||
      gex.data?.meta.available === false
        ? noLevels
        : gex.data || noLevels,
    [gex.data, gex.isError],
  );
  const openAnchor = (kind: "vp" | "vwap") => {
    set({ dialog: null });
    setTool("anchor-" + kind);
    chart.current?.anchor(kind);
  };
  const liveMotion = motionLevel !== "off" && !reduced;
  if (requiresAuth) return <Login />;
  return (
    <MotionConfig
      reducedMotion={liveMotion ? "user" : "always"}
      transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
    >
      <div
        className={"terminal " + (zen ? "zen" : "")}
        data-motion={liveMotion ? motionLevel : "off"}
      >
        <Navigation />
        <div className="workspace">
          <Topbar />
          <AssetRail />
          <div className="workspace-heading">
            <div>
              <span className="workspace-dot" />
              <strong>Espace principal</strong>
              <span className="workspace-subtitle">Analyse uniquement</span>
            </div>
            <div>
              <button
                onClick={() =>
                  set({ dialog: "advanced", advancedTab: "exposure" })
                }
              >
                <Layers3 size={14} />
                Outils
              </button>
              <button onClick={() => set({ dialog: "indicators" })}>
                <SlidersHorizontal size={14} />
                Indicateurs <span className="keycap">VP / VWAP</span>
              </button>
              <button onClick={() => set({ zen: !zen })}>
                <PanelRightClose size={14} />
                {zen ? "Quitter Focus" : "Focus"}
              </button>
            </div>
          </div>
          <main className="terminal-main">
            <section className="chart-panel">
              <div className="chart-toolbar">
                <Quote />
                <div className="chart-actions">
                  <div
                    className="intervals"
                    aria-label="Intervalle du graphique"
                  >
                    {(["1m", "5m", "15m", "30m", "1h", "1d"] as Interval[]).map(
                      (value) => (
                        <button
                          aria-pressed={interval === value}
                          className={interval === value ? "active" : ""}
                          key={value}
                          onClick={() => set({ interval: value })}
                        >
                          {value === "1d"
                            ? "1D"
                            : value === "1h"
                              ? "1H"
                              : value}
                        </button>
                      ),
                    )}
                  </div>
                  <button
                    className="icon-button"
                    aria-label="Cadrer le prix"
                    title="Cadrer le prix"
                    onClick={() => chart.current?.fit()}
                  >
                    <Focus size={17} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label={
                      zen ? "Réduire le graphique" : "Agrandir le graphique"
                    }
                    onClick={() => set({ zen: !zen })}
                  >
                    <Expand size={16} />
                  </button>
                </div>
              </div>
              <div className="chart-filters">
                <div className="expiry-filters" aria-label="Échéances">
                  {(
                    [
                      ["all", "ALL"],
                      ["0dte", "0DTE"],
                      ["weekly", "≤ 7j"],
                      ["monthly", "≤ 35j"],
                    ] as [Filter, string][]
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      aria-pressed={filter === value}
                      className={filter === value ? "active" : ""}
                      onClick={() => set({ filter: value })}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <label className="compact-select">
                  Flux
                  <select
                    value={source}
                    onChange={(event) =>
                      set({ source: event.target.value as typeof source })
                    }
                    disabled={symbol !== "BTC"}
                  >
                    <option value="perp">
                      {symbol === "BTC"
                        ? "Perpétuel BTC"
                        : "Futures / sous-jacent"}
                    </option>
                    {symbol === "BTC" && (
                      <option value="options">Options BTC · prime</option>
                    )}
                  </select>
                </label>
                <div className="chart-layer-controls">
                  <label>
                    <input
                      type="checkbox"
                      checked={showLevels}
                      onChange={(event) => setShowLevels(event.target.checked)}
                    />
                    Niveaux
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={showFlow}
                      onChange={(event) => setShowFlow(event.target.checked)}
                    />
                    Événements
                  </label>
                </div>
              </div>
              <DataNotice />
              <div className="chart-stage">
                <div className="chart-meta">
                  <span>
                    {symbol}{" "}
                    <span className="muted">/ {interval.toUpperCase()}</span>
                  </span>
                  <Ohlc bar={history.data?.bars.at(-1)} />
                </div>
                <div className="drawing-tools" aria-label="Dessins">
                  {(
                    [
                      ["inspect", MousePointer2, "Inspection"],
                      ["hline", Minus, "Ligne horizontale"],
                      ["vline", Minus, "Ligne verticale"],
                      ["trend", TrendingUp, "Tendance · deux clics"],
                      ["rect", Square, "Rectangle · deux clics"],
                      ["ray", TrendingUp, "Rayon · deux clics"],
                      ["fib", Layers3, "Fibonacci · deux clics"],
                    ] as const
                  ).map(([kind, Icon, label]) => (
                    <button
                      key={kind}
                      aria-label={label}
                      title={label}
                      className={tool === kind ? "active" : ""}
                      onClick={() => {
                        setTool(kind);
                        chart.current?.tool(kind);
                      }}
                    >
                      <Icon size={16} />
                    </button>
                  ))}
                  <button
                    aria-label="Gérer les dessins"
                    title="Couleur, épaisseur et coordonnées"
                    onClick={() =>
                      set({ dialog: "advanced", advancedTab: "drawings" })
                    }
                  >
                    <Settings2 size={15} />
                  </button>
                  <span />
                  <button
                    aria-label="Annuler le dernier dessin"
                    title="Annuler"
                    onClick={() => chart.current?.undo()}
                  >
                    <Undo2 size={16} />
                  </button>
                  <button
                    aria-label="Effacer les dessins React"
                    title="Effacer les dessins React"
                    onClick={() => {
                      if (
                        confirm("Effacer les dessins de cet actif dans React ?")
                      )
                        chart.current?.clear();
                    }}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
                <Suspense
                  fallback={
                    <div className="chart-overlay">
                      Chargement du moteur graphique…
                    </div>
                  }
                >
                  <MarketChart
                    ref={chart}
                    bars={history.data?.bars || noBars}
                    baseBars={base.data?.bars || noBars}
                    options={options}
                    levels={levels}
                    flow={flow.data?.bars || noBars}
                    showLevels={showLevels}
                    showFlow={showFlow}
                    onTool={onTool}
                  />
                </Suspense>
                {history.isPending ? (
                  <div className="chart-overlay">
                    <span className="loading-orbit" />
                    Chargement des bougies…
                  </div>
                ) : history.isError || !history.data?.bars.length ? (
                  <div className="chart-overlay">
                    <Empty
                      title={
                        history.isError
                          ? "Historique indisponible"
                          : "Aucune bougie disponible"
                      }
                      action={
                        <button onClick={() => history.refetch()}>
                          Réessayer
                        </button>
                      }
                    >
                      Aucun prix ou historique artificiel n’est affiché.
                    </Empty>
                  </div>
                ) : null}
                {tool !== "inspect" && (
                  <div className="tool-hint">
                    {tool.startsWith("anchor")
                      ? "Cliquez une bougie pour ancrer " +
                        (tool.endsWith("vwap") ? "le VWAP" : "le VP")
                      : tool === "hline"
                        ? "Cliquez un prix pour placer le repère"
                        : "Choisissez deux points sur le graphique"}
                    <span>Échap pour annuler</span>
                  </div>
                )}
              </div>
              <button
                className="indicator-caption"
                onClick={() => set({ dialog: "indicators" })}
              >
                <span className="legend-line vp" />
                VP {options.vp.enabled ? options.vp.period : "masqué"}
                <span className="legend-line vwap" />
                VWAP {options.vwap.enabled ? options.vwap.period : "masqué"}
                <span className="caption-method">
                  Base {options.base} · estimations OHLCV ·{" "}
                  {base.isError
                    ? "source indisponible"
                    : base.isPending
                      ? "chargement"
                      : "couverture partielle possible"}
                </span>
                <SlidersHorizontal size={12} />
              </button>
              <Inspector />
            </section>
            <Sidebar />
          </main>
          <footer className="statusbar">
            <span>
              <span className="status-light" />
              GEX <strong>REACT</strong>
              <small>Sources traçables</small>
            </span>
            <span>
              Analyse uniquement <span className="footer-dot">·</span> Aucune
              exécution d’ordres
            </span>
            <button onClick={() => set({ dialog: "settings" })}>
              <Command size={11} />
              Préférences
            </button>
          </footer>
        </div>
        <WorkspaceDialog
          anchor={openAnchor}
          focusPrice={(price) => {
            chart.current?.focusPrice(price);
            set({ dialog: null });
          }}
        />
      </div>
    </MotionConfig>
  );
}
export function BootstrapError({ message }: { message: string }) {
  return (
    <div className="login-screen">
      <Brand />
      <h1>Le terminal n’a pas pu démarrer.</h1>
      <p>{message}</p>
      <a href="/classic/">
        <ArrowLeft size={15} />
        Revenir à l’interface classique
      </a>
    </div>
  );
}
// Intentionally retained as a typed API check for integrations.
export const health = () => api<{ ok?: boolean }>("/api/health");
