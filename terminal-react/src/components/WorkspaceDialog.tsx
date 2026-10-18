import { useEffect, useRef, useState, lazy, Suspense } from "react";
import { motion } from "motion/react";
import { X, Download, MousePointer2, Info } from "lucide-react";
import { useWorkspace } from "../lib/store";
import { useFlow, useReplay } from "../hooks/useData";
import { price, compact } from "../lib/api";
import { Badge, Empty } from "./UI";
import type { IndicatorConfig, ReplayRow } from "../lib/types";
const AdvancedWorkspace = lazy(() => import("./AdvancedWorkspace"));
const periods = [
  ["daily", "Daily / session"],
  ["weekly", "Weekly · lundi"],
  ["monthly", "Monthly"],
  ["anchored", "Ancré sur le graphique"],
];
function Choice({
  label,
  value,
  items,
  onChange,
}: {
  label: string;
  value: string;
  items: string[][];
  onChange: (value: string) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {items.map(([key, name]) => (
          <option key={key} value={key}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}
function Numeric({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        aria-label={label}
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => {
          if (event.target.value !== "") onChange(event.target.valueAsNumber);
        }}
      />
    </label>
  );
}
function IndicatorSettings({
  anchor,
}: {
  anchor: (kind: "vp" | "vwap") => void;
}) {
  const options = useWorkspace((s) => s.indicators),
    update = useWorkspace((s) => s.updateIndicators);
  const [tab, setTab] = useState<"vp" | "vwap">("vp");
  const config = options[tab];
  const change = (field: keyof IndicatorConfig, value: unknown) =>
    update({ ...options, [tab]: { ...config, [field]: value } });
  const toggle = (field: keyof IndicatorConfig, label: string) => (
    <label className="check-field">
      <input
        type="checkbox"
        checked={!!config[field]}
        onChange={(event) => change(field, event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
  return (
    <>
      <div className="method-note">
        <Info size={16} />
        <p>
          <strong>Une base de calcul indépendante du graphique.</strong> VP et
          VWAP sont estimés à partir d’OHLCV. Ni profil de transactions exact,
          ni TPO. Weekly et Monthly peuvent être tronqués par l’historique
          disponible.
        </p>
      </div>
      <Choice
        label="Base de calcul"
        value={options.base}
        items={["1m", "5m", "15m", "30m", "1h"].map((x) => [x, x])}
        onChange={(value) =>
          update({ ...options, base: value as typeof options.base })
        }
      />
      <div className="settings-tabs" role="tablist" aria-label="Indicateur">
        <button
          role="tab"
          aria-selected={tab === "vp"}
          onClick={() => setTab("vp")}
        >
          01 · Volume Profile
        </button>
        <button
          role="tab"
          aria-selected={tab === "vwap"}
          onClick={() => setTab("vwap")}
        >
          02 · VWAP
        </button>
      </div>
      <div className="settings-fields">
        {toggle("enabled", "Afficher cet indicateur")}
        <Choice
          label={tab === "vp" ? "Période" : "Réinitialisation"}
          value={config.period}
          items={
            tab === "vp" ? [...periods, ["visible", "Plage visible"]] : periods
          }
          onChange={(value) => change("period", value)}
        />
        <Choice
          label="Séance"
          value={config.session}
          items={[
            ["auto", "Auto selon l’actif"],
            ["day", "Journée · fuseau choisi"],
            ["rth", "RTH 09:30–16:00 New York"],
            ["eth", "ETH 18:00–17:00 New York"],
          ]}
          onChange={(value) => change("session", value)}
        />
        <Choice
          label="Fuseau journée"
          value={config.zone}
          items={[
            ["UTC", "UTC"],
            ["America/New_York", "New York"],
            ["Europe/London", "Londres"],
            ["Asia/Tokyo", "Tokyo"],
          ]}
          onChange={(value) => change("zone", value)}
        />
        {tab === "vp" ? (
          <>
            <Choice
              label="Profils affichés"
              value={config.history || "current"}
              items={[
                ["current", "Dernière période disponible"],
                ["previous", "Précédente disponible"],
                ["three", "3 dernières · juxtaposées"],
              ]}
              onChange={(value) => change("history", value)}
            />
            <Choice
              label="Construction"
              value={config.resolution || "rows"}
              items={[
                ["rows", "Nombre de niveaux"],
                ["step", "Pas de prix"],
              ]}
              onChange={(value) => change("resolution", value)}
            />
            {config.resolution === "step" ? (
              <Numeric
                label="Pas de prix (512 bins maximum)"
                value={config.step || 10}
                min={0.000001}
                max={1e7}
                step={0.01}
                onChange={(value) => change("step", value)}
              />
            ) : (
              <Numeric
                label="Nombre de niveaux"
                value={config.rows || 64}
                min={8}
                max={256}
                onChange={(value) => change("rows", value)}
              />
            )}
            <Numeric
              label="Value Area (%)"
              value={config.valueArea || 70}
              min={1}
              max={100}
              onChange={(value) => change("valueArea", value)}
            />
            <Choice
              label="Position"
              value={config.side || "left"}
              items={[
                ["left", "À gauche"],
                ["right", "À droite"],
              ]}
              onChange={(value) => change("side", value)}
            />
            <Numeric
              label="Largeur du graphique (%)"
              value={config.width}
              min={5}
              max={35}
              onChange={(value) => change("width", value)}
            />
            <Numeric
              label="Opacité"
              value={config.opacity ?? 0.27}
              min={0.05}
              max={0.8}
              step={0.05}
              onChange={(value) => change("opacity", value)}
            />
            <label className="field">
              <span>Couleur hors Value Area</span>
              <input
                type="color"
                value={config.outside || "#627bc4"}
                onChange={(event) => change("outside", event.target.value)}
              />
            </label>
            {toggle("poc", "Afficher POC")}
            {toggle("va", "Afficher VAH / VAL")}
          </>
        ) : (
          <>
            <Choice
              label="Bandes"
              value={config.bands || "sigma"}
              items={[
                ["none", "Aucune"],
                ["sigma", "Écart-type pondéré (σ)"],
                ["percent", "Pourcentage du VWAP"],
              ]}
              onChange={(value) => change("bands", value)}
            />
            <Numeric
              label="Nombre de bandes (±)"
              value={config.bandCount || 2}
              min={1}
              max={3}
              onChange={(value) => change("bandCount", value)}
            />
            {config.bands === "percent" && (
              <Numeric
                label="Pas des bandes (%)"
                value={config.percent || 1}
                min={0.01}
                max={20}
                step={0.1}
                onChange={(value) => change("percent", value)}
              />
            )}
            <Numeric
              label="Épaisseur"
              value={config.width}
              min={1}
              max={5}
              onChange={(value) => change("width", value)}
            />
            <Choice
              label="Trait"
              value={config.style || "solid"}
              items={[
                ["solid", "Continu"],
                ["dashed", "Tirets"],
                ["dotted", "Pointillé"],
              ]}
              onChange={(value) => change("style", value)}
            />
            {toggle("previous", "Afficher aussi la période précédente")}
            {toggle("labels", "Afficher les labels")}
          </>
        )}
        <label className="field">
          <span>Couleur {tab === "vp" ? "Value Area" : "VWAP"}</span>
          <input
            type="color"
            value={config.color}
            onChange={(event) => change("color", event.target.value)}
          />
        </label>
      </div>
      <div className="anchor-setting">
        <div>
          <strong>
            {config.anchor
              ? new Date(config.anchor * 1000).toLocaleString("fr-FR")
              : "Aucun point d’ancrage"}
          </strong>
          <small>Ancrages indépendants pour chaque actif.</small>
        </div>
        <button className="primary" onClick={() => anchor(tab)}>
          <MousePointer2 size={14} />
          Choisir sur le graphique
        </button>
        <button onClick={() => change("anchor", null)}>Effacer</button>
      </div>
      <p className="fine-print">
        VP : volume réparti uniformément low/high. VWAP : prix typique (H+L+C)/3
        pondéré par le volume. Absence de volume positif = indisponible. Les
        horaires ne certifient ni jours fériés ni demi-séances. Base Deribit
        perp pour BTC, Yahoo pour les autres actifs, pas le tape Rithmic natif.
      </p>
    </>
  );
}
function exportFlow(rows: ReturnType<typeof useFlow>["data"]) {
  if (!rows) return;
  const content = [
    "time_utc,big_total,big_n,abs_buy,abs_sell,abs_n,delta",
    ...rows.bars.map((b) =>
      [
        new Date(b.t * 1000).toISOString(),
        b.big_total,
        b.big_n,
        b.abs_buy,
        b.abs_sell,
        b.abs_n,
        b.delta,
      ].join(","),
    ),
  ].join("\n");
  const link = document.createElement("a"),
    url = URL.createObjectURL(
      new Blob([content], { type: "text/csv;charset=utf-8" }),
    );
  link.href = url;
  link.download = "gex-observations.csv";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function Journal() {
  const query = useFlow();
  return (
    <>
      <>
        {query.isError && (
          <p className="notice">
            Actualisation échouée. Les observations précédemment reçues restent
            consultables.
          </p>
        )}
      </>
      <div className="dialog-toolbar">
        <Badge tone="warning">Reçus uniquement · couverture partielle</Badge>
        <button
          onClick={() => exportFlow(query.data)}
          disabled={!query.data?.bars.length}
        >
          <Download size={14} />
          Exporter CSV
        </button>
      </div>
      {query.data?.bars.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Heure UTC</th>
                <th>Gros trades</th>
                <th>Absorption estimée</th>
                <th>Delta</th>
              </tr>
            </thead>
            <tbody>
              {[...query.data.bars].reverse().map((row) => (
                <tr key={row.t}>
                  <td>
                    {new Date(row.t * 1000).toLocaleString("fr-FR", {
                      timeZone: "UTC",
                    })}
                  </td>
                  <td>
                    {compact(row.big_total)} <small>({row.big_n})</small>
                  </td>
                  <td>
                    {compact(row.abs_buy + row.abs_sell)}{" "}
                    <small>({row.abs_n})</small>
                  </td>
                  <td>{compact(row.delta)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty
          title={
            query.isError ? "Source indisponible" : "Aucune observation reçue"
          }
        >
          {query.data?.reason || "Aucun historique synthétique ne sera ajouté."}
        </Empty>
      )}
      <p className="fine-print">
        Unité : {query.data?.unit || "inconnue"} · contrat :{" "}
        {query.data?.contract || "non résolu"}. Agrégats par bougie, pas un
        registre exhaustif des prints.
      </p>
    </>
  );
}
function ReplayPlot({ rows, index }: { rows: ReplayRow[]; index: number }) {
  const visible = rows.slice(0, index + 1),
    values = visible.map((r) => r.price).filter(Number.isFinite);
  if (!values.length) return null;
  const lo = Math.min(...values),
    hi = Math.max(...values),
    span = hi - lo || 1,
    first = visible[0].recorded_at,
    last = visible[visible.length - 1].recorded_at;
  let path = "",
    previous = 0;
  visible.forEach((row) => {
    if (!Number.isFinite(row.price)) return;
    const x =
        12 + ((row.recorded_at - first) / Math.max(1, last - first)) * 696,
      y = 158 - ((row.price - lo) / span) * 140;
    path += `${!previous || row.recorded_at - previous > 90 ? "M" : "L"}${x},${y} `;
    previous = row.recorded_at;
  });
  return (
    <svg
      className="replay-plot"
      viewBox="0 0 720 180"
      role="img"
      aria-label="Prix des observations connues jusqu’au point sélectionné"
    >
      <path d={path} fill="none" stroke="#80ceba" strokeWidth="2" />
      <text x="12" y="178" fill="#879c9b" fontSize="10">
        Trous non reliés au-delà de 90 secondes
      </text>
    </svg>
  );
}
function Replay() {
  const query = useReplay(true),
    [index, setIndex] = useState(0),
    rows = query.data?.rows || [],
    row = rows[Math.min(index, rows.length - 1)];
  return (
    <>
      <p className="fine-print">
        Snapshots enregistrés uniquement. La sélection ne modifie pas le
        graphique live. Aucun niveau actuel injecté dans le passé.
      </p>
      {row ? (
        <>
          <ReplayPlot rows={rows} index={Math.min(index, rows.length - 1)} />
          <label className="field">
            <span>
              Observation {index + 1} / {rows.length}
            </span>
            <input
              aria-label="Observation de relecture"
              type="range"
              min={0}
              max={rows.length - 1}
              value={Math.min(index, rows.length - 1)}
              onChange={(event) => setIndex(event.target.valueAsNumber)}
            />
          </label>
          <div className="replay-values">
            <span>
              {new Date(row.recorded_at * 1000).toLocaleString("fr-FR")}
              <small>{row.price_mode}</small>
            </span>
            <strong>{price(row.price)}</strong>
            <span>
              CW {price(row.levels.call_wall)}
              <small>
                PW {price(row.levels.put_wall)} · Zero{" "}
                {price(row.levels.zero_gex)}
              </small>
            </span>
          </div>
        </>
      ) : (
        <Empty
          title={
            query.isPending
              ? "Chargement des snapshots"
              : query.isError
                ? "Source indisponible"
                : "Aucune observation enregistrée"
          }
        >
          La relecture nécessite des snapshots réellement enregistrés.
        </Empty>
      )}
    </>
  );
}
function Settings() {
  const motion = useWorkspace((s) => s.motion),
    set = useWorkspace((s) => s.set);
  return (
    <>
      <Choice
        label="Intensité des animations"
        value={motion}
        items={[
          ["rich", "Immersives"],
          ["calm", "Discrètes"],
          ["off", "Désactivées"],
        ]}
        onChange={(value) => set({ motion: value as typeof motion })}
      />
      <p className="fine-print">
        Le réglage système de réduction des mouvements reste prioritaire. Pas
        d’animations sur les chandeliers ni de données décoratives.
      </p>
      <div className="migration-note">
        <Badge>Outils React</Badge>
        <h3>Échéances, scénarios et sources.</h3>
        <p>
          Les outils avancés s’ouvrent directement dans votre espace, sans
          changer d’interface.
        </p>
        <button
          className="primary"
          onClick={() => set({ dialog: "advanced", advancedTab: "exposure" })}
        >
          Ouvrir les outils avancés
        </button>
      </div>
    </>
  );
}
export function WorkspaceDialog({
  anchor,
  focusPrice,
}: {
  focusPrice: (price: number | null) => void;
  anchor: (kind: "vp" | "vwap") => void;
}) {
  const name = useWorkspace((s) => s.dialog),
    set = useWorkspace((s) => s.set),
    symbol = useWorkspace((s) => s.symbol),
    ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (name && !ref.current?.open) ref.current?.showModal();
    if (!name && ref.current?.open) ref.current.close();
  }, [name]);
  const close = () => set({ dialog: null });
  return (
    <dialog
      ref={ref}
      className={
        "workspace-dialog" + (name === "advanced" ? " advanced-dialog" : "")
      }
      onCancel={close}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
      aria-labelledby="dialog-title"
    >
      <motion.div
        key={name}
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="dialog-content"
      >
        <header>
          <div>
            <span className="eyebrow">ESPACE DE TRAVAIL / {symbol}</span>
            <h2 id="dialog-title">
              {name === "advanced"
                ? "Atelier d’analyse"
                : name === "indicators"
                  ? "Profils & prix moyen"
                  : name === "journal"
                    ? "Journal des observations"
                    : name === "replay"
                      ? "Relecture des snapshots GEX"
                      : "Préférences du terminal"}
            </h2>
          </div>
          <button className="icon-button" aria-label="Fermer" onClick={close}>
            <X size={19} />
          </button>
        </header>
        {name === "advanced" ? (
          <Suspense fallback={<p role="status">Ouverture des outils…</p>}>
            <AdvancedWorkspace focusPrice={focusPrice} />
          </Suspense>
        ) : name === "indicators" ? (
          <IndicatorSettings anchor={anchor} />
        ) : name === "journal" ? (
          <Journal />
        ) : name === "replay" ? (
          <Replay key={symbol} />
        ) : name === "settings" ? (
          <Settings />
        ) : null}
      </motion.div>
    </dialog>
  );
}
