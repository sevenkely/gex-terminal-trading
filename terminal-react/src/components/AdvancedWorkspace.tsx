import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, compact, price } from "../lib/api";
import { useWorkspace } from "../lib/store";
import { useDrawings, legacyDrawings, type Drawing } from "../lib/drawings";
import { Badge, Empty } from "./UI";
import type { Gex } from "../lib/types";
import { SessionHeatmap } from "./SessionHeatmap";
import { CombinedReplay } from "./CombinedReplay";
import { DataConnections } from "./DataConnections";
export type AdvancedTab =
  | "exposure"
  | "heatmap"
  | "scenario"
  | "drawings"
  | "research"
  | "replay"
  | "alerts"
  | "sources";
export const advancedTabs: [AdvancedTab, string][] = [
  ["exposure", "Échéances"],
  ["heatmap", "Heatmap"],
  ["scenario", "Scénarios"],
  ["drawings", "Dessins"],
  ["research", "Recherche"],
  ["replay", "Relecture combinée"],
  ["alerts", "Alertes"],
  ["sources", "Sources & connexion"],
];
export function useTool<T>(name: string, path: string, interval = 30000) {
  return useQuery({
    queryKey: ["tools", name, path],
    queryFn: ({ signal }) => api<T>(path, signal),
    refetchInterval: interval || false,
  });
}
export const date = (ts: number) =>
  new Date(ts * 1000).toLocaleString("fr-FR", {
    timeZone: "UTC",
    dateStyle: "short",
    timeStyle: "short",
  }) + " UTC";
export function RequestState({
  pending,
  error,
  retry,
}: {
  pending: boolean;
  error: boolean;
  retry: () => void;
}) {
  return pending ? (
    <p role="status" className="notice">
      Chargement des observations…
    </p>
  ) : error ? (
    <div role="alert" className="notice">
      La source ne répond pas. Aucune donnée de remplacement.{" "}
      <button onClick={retry}>Réessayer</button>
    </div>
  ) : null;
}
interface Exposure {
  available: boolean;
  reason?: string;
  strikes: number[];
  expiries: number[];
  values: number[][];
  counts: number[][];
  unit: string;
  truncated: boolean;
  chain_ts: number;
  price_mode: string;
  limitation: string;
}
function ExposureGrid({
  focusPrice,
}: {
  focusPrice: (price: number | null) => void;
}) {
  const symbol = useWorkspace((s) => s.symbol),
    filter = useWorkspace((s) => s.filter),
    [metric, setMetric] = useState("gamma"),
    [band, setBand] = useState(".05"),
    [selected, setSelected] = useState<{
      strike: number;
      expiry: number;
      value: number;
    } | null>(null);
  const query = useTool<Exposure>(
      "exposure",
      `/api/exposure/${symbol}?filter=${filter}&metric=${metric}&band=${band}`,
      15000,
    ),
    data = query.data;
  const max = Math.max(1, ...(data?.values || []).flat().map(Math.abs));
  return (
    <>
      <div className="tools-controls">
        <label className="field">
          Métrique
          <select
            aria-label="Métrique exposition"
            value={metric}
            onChange={(e) => {
              setMetric(e.target.value);
              setSelected(null);
            }}
          >
            <option value="gamma">Gamma</option>
            <option value="vanna">Vanna</option>
          </select>
        </label>
        <label className="field">
          Fenêtre
          <select
            aria-label="Fenêtre exposition"
            value={band}
            onChange={(e) => {
              setBand(e.target.value);
              setSelected(null);
            }}
          >
            {[".03", ".05", ".10", ".15"].map((v) => (
              <option key={v} value={v}>
                ±{Number(v) * 100}%
              </option>
            ))}
          </select>
        </label>
        <Badge>
          {filter.toUpperCase()} · {symbol}
        </Badge>
      </div>
      <RequestState
        pending={query.isPending}
        error={query.isError}
        retry={() => void query.refetch()}
      />
      {!query.isError && data?.available && (
        <>
          <p className="fine-print">
            {data.unit} · chaîne {date(data.chain_ts)} · {data.price_mode}.{" "}
            {data.truncated
              ? "Grille tronquée : premières 24 échéances / 160 strikes maximum."
              : ""}
          </p>
          <div className="table-scroll exposure-scroll">
            <table className="exposure-grid">
              <caption>Exposition {metric} par strike et échéance</caption>
              <thead>
                <tr>
                  <th scope="col">Strike</th>
                  {data.expiries.map((t) => (
                    <th scope="col" key={t}>
                      {date(t)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.strikes.map((k, i) => (
                  <tr key={k}>
                    <th scope="row">{price(k)}</th>
                    {data.expiries.map((t, j) => (
                      <td key={t}>
                        {data.counts[i]?.[j] > 0 ? (
                          <button
                            className={
                              selected?.strike === k && selected.expiry === t
                                ? "selected"
                                : ""
                            }
                            style={{
                              background: `${data.values[i][j] < 0 ? "rgba(233,157,164," : "rgba(145,215,189,"}${0.08 + (0.6 * Math.abs(data.values[i][j])) / max})`,
                            }}
                            aria-label={`${price(k)} · ${date(t)} · ${data.values[i][j]} ${data.unit}`}
                            onClick={() =>
                              setSelected({
                                strike: k,
                                expiry: t,
                                value: data.values[i][j],
                              })
                            }
                          >
                            {compact(data.values[i][j])}
                          </button>
                        ) : (
                          "—"
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {selected && (
            <div className="method-note">
              <p>
                Strike {price(selected.strike)} · {date(selected.expiry)} ·{" "}
                {compact(selected.value)} {data.unit}
              </p>
              <button
                className="primary"
                onClick={() => focusPrice(selected.strike)}
              >
                Voir ce strike sur le graphique
              </button>
            </div>
          )}
          <p className="fine-print">
            {data.limitation} Couleurs normalisées à cette grille ; « — » =
            absent, 0 = exposition nette observée nulle.
          </p>
        </>
      )}
      {!query.isPending && !query.isError && !data?.available && (
        <Empty
          title="Aucune exposition disponible"
          detail={data?.reason || "Chaîne non disponible pour ce filtre."}
        />
      )}
    </>
  );
}
function Profile({ data }: { data: Gex }) {
  const max = Math.max(1, ...(data.net_gex || []).map(Math.abs));
  return (
    <>
      <div className="tools-metrics">
        <span>
          Net GEX<strong>{compact(data.net_gex_total)}</strong>
        </span>
        <span>
          Call Wall<strong>{price(data.call_wall)}</strong>
        </span>
        <span>
          Put Wall<strong>{price(data.put_wall)}</strong>
        </span>
        <span>
          Zero Gamma<strong>{price(data.zero_gex)}</strong>
        </span>
      </div>
      <div className="table-scroll">
        <table>
          <caption>Profil global par strike</caption>
          <thead>
            <tr>
              <th>Strike</th>
              <th>Net GEX (USD / +1% spot)</th>
              <th>Concentration</th>
            </tr>
          </thead>
          <tbody>
            {data.strikes?.map((k, i) => (
              <tr key={k}>
                <th scope="row">{price(k)}</th>
                <td>{compact(data.net_gex?.[i])}</td>
                <td>
                  <span
                    className="profile-bar"
                    style={{
                      width: `${Math.max(0, Math.abs(data.net_gex?.[i] || 0) / max) * 100}%`,
                      background:
                        (data.net_gex?.[i] || 0) < 0
                          ? "var(--rose)"
                          : "var(--mint)",
                    }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
function Scenarios() {
  const symbol = useWorkspace((s) => s.symbol),
    filter = useWorkspace((s) => s.filter),
    [input, setInput] = useState({ spot: 0, iv: 0, minutes: 0 }),
    [params, setParams] = useState<typeof input | null>(null);
  const path = params
    ? `/api/scenario/${symbol}?filter=${filter}&dspot=${params.spot / 100}&div=${params.iv}&minutes=${params.minutes}`
    : "";
  const query = useQuery({
    queryKey: ["scenario", path],
    queryFn: ({ signal }) => api<Gex>(path, signal),
    enabled: !!params,
    retry: false,
  });
  return (
    <>
      <p className="fine-print">
        Revalorisation Black-Scholes de la chaîne observée, OI constant.
        Scénario hypothétique, pas une prévision ni des prix de marché.
      </p>
      <form
        className="tools-controls"
        onSubmit={(e) => {
          e.preventDefault();
          setParams({ ...input });
        }}
      >
        {(
          [
            ["spot", "Variation du spot (%)", -10, 10, 0.1],
            ["iv", "Variation IV (points)", -15, 15, 0.5],
            ["minutes", "Avance (minutes)", 0, 1440, 1],
          ] as const
        ).map(([key, label, min, max, step]) => (
          <label className="field" key={key}>
            {label}
            <input
              required
              type="number"
              min={min}
              max={max}
              step={step}
              value={input[key]}
              onChange={(e) =>
                setInput({ ...input, [key]: e.target.valueAsNumber })
              }
            />
          </label>
        ))}
        <button className="primary" type="submit" disabled={query.isFetching}>
          Calculer le scénario
        </button>
        <button
          type="button"
          onClick={() => {
            setInput({ spot: 0, iv: 0, minutes: 0 });
            setParams(null);
          }}
        >
          Réinitialiser
        </button>
      </form>
      {params && (
        <>
          <RequestState
            pending={query.isPending}
            error={query.isError}
            retry={() => void query.refetch()}
          />
          {!query.isError &&
            query.data &&
            (query.data.available === false ? (
              <Empty
                title="Aucune option éligible"
                detail="Le scénario conserve votre filtre, sans bascule ALL."
              />
            ) : (
              <>
                <Badge tone="warning">
                  Hypothèse : {params.spot}% spot · {params.iv} pts IV · +
                  {params.minutes} min
                </Badge>
                <Profile data={query.data} />
              </>
            ))}
        </>
      )}
    </>
  );
}
export function DrawingEditor() {
  const symbol = useWorkspace((s) => s.symbol),
    all = useDrawings((s) => s.bySymbol[symbol]),
    replace = useDrawings((s) => s.replace);
  useEffect(() => useDrawings.getState().load(symbol), [symbol]);
  const rows = all || [];
  const update = (id: string, patch: Partial<Drawing>) =>
    replace(
      symbol,
      rows.map((d) => (d.id === id ? { ...d, ...patch } : d)),
    );
  return (
    <>
      <p className="fine-print">
        Sélectionnez un outil sur le graphique pour créer un objet. Prix et
        coordonnées temporelles éditables ici, même hors de la fenêtre visible.
        Les objets masqués et verrouillés sont conservés.
      </p>
      <div className="tools-controls">
        <button
          onClick={() => {
            try {
              const raw = JSON.parse(
                localStorage.getItem("gex.draw." + symbol) || "[]",
              );
              const imported = legacyDrawings(raw);
              if (!imported.length) {
                alert("Aucun dessin classique valide trouvé pour cet actif.");
                return;
              }
              if (
                confirm(
                  "Copier " +
                    imported.length +
                    " dessins classiques vers React (les originaux sont conservés) ?",
                )
              )
                replace(symbol, [...rows, ...imported]);
            } catch {
              alert("Stockage classique indisponible ou invalide.");
            }
          }}
        >
          Importer les dessins classiques
        </button>
        <button onClick={() => useDrawings.getState().undo(symbol)}>
          Annuler la dernière modification
        </button>
        <button onClick={() => useDrawings.getState().redo(symbol)}>
          Rétablir la modification
        </button>
        <button
          disabled={!rows.length}
          onClick={() => {
            if (confirm("Supprimer tous les dessins de " + symbol + " ?"))
              replace(
                symbol,
                rows.filter((d) => d.locked),
              );
          }}
        >
          Tout supprimer
        </button>
      </div>
      {!rows.length ? (
        <Empty
          title="Aucun dessin pour cet actif"
          detail="Repère horizontal, tendance et rectangle sont disponibles sur le graphique."
        />
      ) : (
        rows.map((d, i) => (
          <fieldset className="drawing-editor" key={d.id}>
            <legend>
              {i + 1} ·{" "}
              {
                {
                  hline: "Horizontal",
                  vline: "Vertical",
                  trend: "Tendance",
                  ray: "Rayon",
                  rect: "Rectangle",
                  fib: "Fibonacci",
                }[d.kind]
              }
            </legend>
            <div className="tools-controls">
              <label className="field">
                Nom
                <input
                  aria-label={`Nom dessin ${i + 1}`}
                  disabled={d.locked}
                  maxLength={60}
                  value={d.label}
                  onChange={(e) => update(d.id, { label: e.target.value })}
                />
              </label>
              <label className="field">
                Couleur
                <input
                  aria-label={`Couleur dessin ${i + 1}`}
                  disabled={d.locked}
                  type="color"
                  value={d.color}
                  onChange={(e) => update(d.id, { color: e.target.value })}
                />
              </label>
              <label className="field">
                Épaisseur (px)
                <input
                  aria-label={`Épaisseur dessin ${i + 1}`}
                  disabled={d.locked}
                  type="number"
                  min={1}
                  max={8}
                  step={0.5}
                  value={d.width}
                  onChange={(e) => {
                    if (Number.isFinite(e.target.valueAsNumber))
                      update(d.id, { width: e.target.valueAsNumber });
                  }}
                />
              </label>
            </div>
            <div className="tools-controls">
              {(["a", "b"] as const)
                .filter((k) => d[k])
                .map((k) => (
                  <div key={k} className="tools-controls">
                    <label className="field">
                      Point {k.toUpperCase()} · prix
                      <input
                        disabled={d.locked}
                        aria-label={`Prix ${k} dessin ${i + 1}`}
                        required
                        type="number"
                        min={0.000001}
                        step="any"
                        value={d[k]!.price}
                        onChange={(e) => {
                          const p = e.target.valueAsNumber;
                          if (p > 0)
                            update(d.id, { [k]: { ...d[k], price: p } });
                        }}
                      />
                    </label>
                    <label className="field">
                      Point {k.toUpperCase()} · heure UTC
                      <input
                        disabled={d.locked}
                        aria-label={`Heure ${k} dessin ${i + 1}`}
                        type="datetime-local"
                        step={1}
                        value={new Date(d[k]!.time * 1000)
                          .toISOString()
                          .slice(0, 19)}
                        onChange={(e) => {
                          const t = Date.parse(e.target.value + "Z") / 1000;
                          if (Number.isFinite(t) && t > 0)
                            update(d.id, { [k]: { ...d[k], time: t } });
                        }}
                      />
                    </label>
                  </div>
                ))}
            </div>
            <div className="tools-controls">
              <label className="field">
                Trait
                <select
                  disabled={d.locked}
                  value={d.dash}
                  onChange={(e) =>
                    update(d.id, { dash: e.target.value as Drawing["dash"] })
                  }
                >
                  <option value="solid">Continu</option>
                  <option value="dashed">Tirets</option>
                  <option value="dotted">Pointillés</option>
                </select>
              </label>
              <label className="field">
                Opacité (%)
                <input
                  disabled={d.locked}
                  type="number"
                  min={5}
                  max={100}
                  value={Math.round(d.opacity * 100)}
                  onChange={(e) => {
                    if (Number.isFinite(e.target.valueAsNumber))
                      update(d.id, { opacity: e.target.valueAsNumber / 100 });
                  }}
                />
              </label>
              {d.kind === "rect" && (
                <label className="field">
                  Remplissage (%)
                  <input
                    disabled={d.locked}
                    type="number"
                    min={0}
                    max={100}
                    value={d.fill}
                    onChange={(e) => {
                      if (Number.isFinite(e.target.valueAsNumber))
                        update(d.id, { fill: e.target.valueAsNumber });
                    }}
                  />
                </label>
              )}
            </div>
            <div className="tools-controls">
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={d.hidden}
                  onChange={(e) => update(d.id, { hidden: e.target.checked })}
                />
                Masquer
              </label>
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={d.locked}
                  onChange={(e) => update(d.id, { locked: e.target.checked })}
                />
                Verrouiller
              </label>
              <button
                disabled={d.locked}
                onClick={() =>
                  replace(
                    symbol,
                    rows.filter((row) => row.id !== d.id),
                  )
                }
              >
                Supprimer le dessin {i + 1}
              </button>
            </div>
          </fieldset>
        ))
      )}
    </>
  );
}
interface TapeRow {
  instrument: string;
  ts: number;
  strike: number;
  option_type: string;
  expiry: number;
  side: string;
  premium_usd: number;
  amount: number;
  bid?: number;
  ask?: number;
  trade_type?: string;
  iv?: number;
}
interface Tape {
  available?: boolean;
  reason?: string;
  rows: TapeRow[];
  source?: string;
  live?: boolean;
  limitation?: string;
}
function Research() {
  const symbol = useWorkspace((s) => s.symbol),
    [contract, setContract] = useState(""),
    [minimum, setMinimum] = useState(0),
    [kind, setKind] = useState("all"),
    [sort, setSort] = useState<"ts" | "premium_usd" | "amount">("ts");
  const tape = useTool<Tape>(
    "tape",
    `/api/option-flow/${symbol}?${contract ? "contract=" + encodeURIComponent(contract) + "&" : ""}minimum=${minimum}&kind=${kind}&limit=200`,
    5000,
  );
  const derivs = useTool<{
    available: boolean;
    reason?: string;
    expiries: {
      expiry: number;
      atm_iv: number | null;
      skew_25d: number | null;
      call_oi: number;
      put_oi: number;
      max_pain: number | null;
    }[];
  }>("derivs", `/api/derivs/${symbol}`);
  const risk = useTool<{
    available: boolean;
    reason?: string;
    vanna_usd_per_vol_point: number;
    charm_usd_per_calendar_day: number;
    limitation: string;
  }>("risk", `/api/risk/${symbol}?filter=${useWorkspace((s) => s.filter)}`);
  const rows = useMemo(
    () =>
      [...(tape.data?.rows || [])].sort(
        (a, b) => (b[sort] || 0) - (a[sort] || 0),
      ),
    [tape.data, sort],
  );
  return (
    <>
      <h3>Tape options observé</h3>
      <div className="tools-controls">
        <label className="field">
          Contrat
          <input
            aria-label="Recherche contrat"
            value={contract}
            maxLength={128}
            onChange={(e) => setContract(e.target.value)}
          />
        </label>
        <label className="field">
          Prime minimum (USD)
          <input
            aria-label="Prime minimum"
            type="number"
            min={0}
            max={1e9}
            value={minimum}
            onChange={(e) =>
              setMinimum(
                Math.max(0, Math.min(1e9, e.target.valueAsNumber || 0)),
              )
            }
          />
        </label>
        <label className="field">
          Type
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="all">Tous</option>
            <option value="C">Call</option>
            <option value="P">Put</option>
          </select>
        </label>
        <label className="field">
          Tri
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as typeof sort)}
          >
            <option value="ts">Heure</option>
            <option value="premium_usd">Prime</option>
            <option value="amount">Quantité</option>
          </select>
        </label>
      </div>
      <RequestState
        pending={tape.isPending}
        error={tape.isError}
        retry={() => void tape.refetch()}
      />
      {!tape.isError &&
        (rows.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {[
                    "Heure UTC",
                    "Contrat",
                    "Strike",
                    "C/P",
                    "Sens",
                    "Prime USD",
                    "Quantité",
                    "Bid",
                    "Ask",
                    "Type source",
                  ].map((t) => (
                    <th key={t}>{t}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.instrument + "-" + r.ts + "-" + i}>
                    <td>{date(r.ts)}</td>
                    <td>{r.instrument}</td>
                    <td>{price(r.strike)}</td>
                    <td>{r.option_type}</td>
                    <td>{r.side || "inconnu"}</td>
                    <td>{compact(r.premium_usd)}</td>
                    <td>{compact(r.amount)}</td>
                    <td>{price(r.bid)}</td>
                    <td>{price(r.ask)}</td>
                    <td>{r.trade_type || "unknown"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          !tape.isPending && (
            <Empty
              title="Aucun trade options reçu"
              detail={
                tape.data?.reason ||
                "Aucun print correspondant ; ce n’est pas un volume nul."
              }
            />
          )
        ))}
      <p className="fine-print">
        {tape.data?.source} ·{" "}
        {tape.data?.limitation ||
          "Sens source uniquement. Aucune déduction artificielle de sweep, ni de dark pool."}
      </p>
      <h3 className="tool-section">Structure par échéance</h3>
      <RequestState
        pending={derivs.isPending}
        error={derivs.isError}
        retry={() => void derivs.refetch()}
      />
      {!derivs.isError && derivs.data?.available ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {[
                  "Échéance UTC",
                  "IV ATM %",
                  "Skew 25Δ pts",
                  "OI Call",
                  "OI Put",
                  "Max pain",
                ].map((t) => (
                  <th key={t}>{t}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {derivs.data.expiries.map((r) => (
                <tr key={r.expiry}>
                  <td>{date(r.expiry)}</td>
                  <td>{r.atm_iv == null ? "—" : price(r.atm_iv * 100)}</td>
                  <td>{price(r.skew_25d)}</td>
                  <td>{compact(r.call_oi)}</td>
                  <td>{compact(r.put_oi)}</td>
                  <td>{price(r.max_pain)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        !derivs.isPending &&
        !derivs.isError && <p className="notice">{derivs.data?.reason}</p>
      )}
      <h3 className="tool-section">Sensibilités du modèle</h3>
      <RequestState
        pending={risk.isPending}
        error={risk.isError}
        retry={() => void risk.refetch()}
      />
      {!risk.isError && risk.data?.available ? (
        <>
          <div className="tools-metrics">
            <span>
              Vanna / +1 pt IV
              <strong>{compact(risk.data.vanna_usd_per_vol_point)}</strong>
            </span>
            <span>
              Charm / jour calendaire
              <strong>{compact(risk.data.charm_usd_per_calendar_day)}</strong>
            </span>
          </div>
          <p className="fine-print">{risk.data.limitation}</p>
        </>
      ) : (
        !risk.isPending &&
        !risk.isError && <p className="notice">{risk.data?.reason}</p>
      )}
    </>
  );
}
function Alerts() {
  const symbol = useWorkspace((s) => s.symbol),
    query = useTool<{
      alerts: {
        seq: number;
        ts: number;
        message?: string;
        text?: string;
        level?: string;
        direction?: string;
        price?: number;
      }[];
    }>("alerts", `/api/alerts/${symbol}`, 5000);
  return (
    <>
      <p className="fine-print">
        Franchissements enregistrés par le serveur (Call Wall, Put Wall, Zero
        Gamma). Le serveur suspend ces alertes si la source ou la projection est
        périmée.
      </p>
      <RequestState
        pending={query.isPending}
        error={query.isError}
        retry={() => void query.refetch()}
      />
      {!query.isError &&
        (query.data?.alerts.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Heure UTC</th>
                  <th>Niveau</th>
                  <th>Direction</th>
                  <th>Prix</th>
                </tr>
              </thead>
              <tbody>
                {[...query.data.alerts].reverse().map((r, i) => (
                  <tr key={r.seq || i}>
                    <td>{date(r.ts)}</td>
                    <td>{r.text || r.message || r.level}</td>
                    <td>{r.direction}</td>
                    <td>{price(r.price)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          !query.isPending && (
            <Empty
              title="Aucune alerte observée"
              detail="Aucun franchissement confirmé reçu. Ce panneau n'exécute aucun ordre."
            />
          )
        ))}
    </>
  );
}
export default function AdvancedWorkspace({
  focusPrice,
}: {
  focusPrice: (price: number | null) => void;
}) {
  const tab = useWorkspace((s) => s.advancedTab),
    symbol = useWorkspace((s) => s.symbol),
    set = useWorkspace((s) => s.set);
  return (
    <>
      <div role="tablist" aria-label="Outils avancés" className="tools-tabs">
        {advancedTabs.map(([key, label]) => (
          <button
            key={key}
            role="tab"
            id={"tool-tab-" + key}
            aria-controls={"tool-panel-" + key}
            aria-selected={key === tab}
            onClick={() => set({ advancedTab: key })}
          >
            {label}
          </button>
        ))}
      </div>
      <section
        role="tabpanel"
        id={"tool-panel-" + tab}
        aria-labelledby={"tool-tab-" + tab}
        key={symbol + "|" + tab}
      >
        {tab === "exposure" ? (
          <ExposureGrid focusPrice={focusPrice} />
        ) : tab === "heatmap" ? (
          <SessionHeatmap focusPrice={focusPrice} />
        ) : tab === "scenario" ? (
          <Scenarios />
        ) : tab === "drawings" ? (
          <DrawingEditor />
        ) : tab === "research" ? (
          <Research />
        ) : tab === "replay" ? (
          <CombinedReplay />
        ) : tab === "alerts" ? (
          <Alerts />
        ) : (
          <DataConnections />
        )}
      </section>
    </>
  );
}
