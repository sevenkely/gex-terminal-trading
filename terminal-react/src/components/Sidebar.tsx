import {
  ArrowUpRight,
  Info,
  ChevronRight,
  Activity,
  Layers3,
} from "lucide-react";
import { useGex, useFlow } from "../hooks/useData";
import { useWorkspace } from "../lib/store";
import { useMarket } from "../lib/stream";
import { compact, price } from "../lib/api";
import { Badge, Empty, useClock } from "./UI";
export function Sidebar() {
  const panel = useWorkspace((s) => s.panel),
    symbol = useWorkspace((s) => s.symbol),
    filter = useWorkspace((s) => s.filter),
    set = useWorkspace((s) => s.set);
  const query = useGex(),
    flow = useFlow(),
    market = useMarket(symbol + "|" + filter),
    now = useClock();
  const gex = query.data,
    meta = { ...gex?.meta, ...market.tick?.data_status },
    levels = { ...gex, ...market.tick?.levels },
    available = meta.available !== false && levels.available !== false && !!gex;
  const age = meta.chain_ts_epoch
    ? now / 1000 - meta.chain_ts_epoch
    : meta.chain_age_seconds;
  const stale =
      typeof age === "number" && age > (symbol === "BTC" ? 180 : 1800),
    basis = meta.projection?.fresh === false;
  const spot = market.tick?.price ?? gex?.meta.spot;
  const net = available ? levels.net_gex_total : undefined;
  const regime =
    levels.regime === "short_gamma"
      ? "Short gamma"
      : levels.regime === "long_gamma"
        ? "Long gamma"
        : "Gamma neutre";
  return (
    <aside className="context-panel">
      <div className="panel-tabs" role="tablist" aria-label="Contexte">
        <button
          role="tab"
          aria-selected={panel === "levels"}
          onClick={() => set({ panel: "levels" })}
        >
          <Layers3 size={14} />
          Niveaux & GEX
        </button>
        <button
          role="tab"
          aria-selected={panel === "flow"}
          onClick={() => set({ panel: "flow" })}
        >
          <Activity size={14} />
          Flux
        </button>
      </div>
      {panel === "levels" ? (
        <>
          <div className="section-heading">
            <span>CONTEXTE DE MARCHÉ</span>
            <span className="estimated">Modèle estimé</span>
          </div>
          {query.isError ? (
            <Empty
              title="Chaîne indisponible"
              action={
                <button onClick={() => query.refetch()}>Réessayer</button>
              }
            >
              Impossible de lire cette source pour le moment.
            </Empty>
          ) : !available ? (
            <Empty
              title={
                query.isPending
                  ? "Chargement de la chaîne"
                  : "Aucune donnée sur ce filtre"
              }
              action={
                !query.isPending ? (
                  <button onClick={() => set({ filter: "all" })}>
                    Afficher ALL
                  </button>
                ) : null
              }
            >
              Aucun niveau n’est remplacé par un zéro.
            </Empty>
          ) : (
            <>
              <div className="regime-line">
                <span
                  className={
                    "regime-dot " +
                    (levels.regime === "short_gamma" ? "negative" : "positive")
                  }
                />
                <strong>{regime}</strong>
                <small>estimé</small>
              </div>
              <div className="net-gex">
                <span>
                  Net GEX <span className="muted">/ +1 % du spot</span>
                </span>
                <strong
                  className={
                    typeof net === "number" && net < 0 ? "negative" : "positive"
                  }
                >
                  {typeof net === "number" ? "$" + compact(net) : "—"}
                </strong>
                <p>Exposition estimée de la chaîne sélectionnée.</p>
              </div>
              <div className="expected">
                <span>
                  Mouvement attendu <small>1σ</small>
                </span>
                <strong>
                  ±{" "}
                  {price(
                    typeof levels.em_up === "number" && typeof spot === "number"
                      ? Math.abs(levels.em_up - spot)
                      : undefined,
                  )}
                </strong>
              </div>
              <div className="section-heading levels-heading">
                <span>NIVEAUX CLÉS</span>
                <span>Prix / distance</span>
              </div>
              {(
                [
                  [levels.call_wall, "Call Wall", "positive"],
                  [levels.put_wall, "Put Wall", "negative"],
                  [
                    levels.gamma_flip ?? levels.zero_gex,
                    "Zero Gamma",
                    "warning",
                  ],
                ] as const
              ).map(([value, label, tone]) => (
                <div className={"level-card " + tone} key={label}>
                  <div>
                    <span className="level-tick" />
                    <strong>{label}</strong>
                    <ArrowUpRight size={13} />
                  </div>
                  <div>
                    <b>{price(value)}</b>
                    <small>
                      {typeof value === "number" &&
                      typeof spot === "number" &&
                      spot > 0
                        ? `${((value / spot - 1) * 100).toFixed(2)} %`
                        : "—"}
                    </small>
                  </div>
                  {(stale || basis) && (
                    <span className="level-warning">
                      {basis ? "Projection périmée" : "Ancien snapshot"}
                    </span>
                  )}
                </div>
              ))}
            </>
          )}
          <div className="source-panel">
            <h3>
              <Info size={13} /> Provenance des données
            </h3>
            <dl>
              <div>
                <dt>Prix</dt>
                <dd>
                  {market.status === "connected" &&
                  now - market.received < 20000
                    ? market.tick?.mode || "Connecté"
                    : market.status === "connected"
                      ? "Flux silencieux"
                      : market.status === "permission"
                        ? "Accès requis"
                        : market.status === "connecting"
                          ? "Connexion…"
                          : "WebSocket interrompu"}
                </dd>
              </div>
              <div>
                <dt>Chaîne options</dt>
                <dd>
                  {typeof age === "number"
                    ? `${Math.max(0, Math.floor(age / 60))} min`
                    : "Âge inconnu"}
                  {stale && <i className="warning-dot" />}
                </dd>
              </div>
              <div>
                <dt>Open interest</dt>
                <dd>{meta.oi_reference || "Référence inconnue"}</dd>
              </div>
              {meta.gex_source && (
                <div>
                  <dt>Projection</dt>
                  <dd>
                    {meta.gex_source} → {symbol}
                    {basis ? " · périmée" : ""}
                  </dd>
                </div>
              )}
            </dl>
            <p>
              GEX estimé, pas du positionnement dealer observé. Les niveaux ne
              sont pas des probabilités de rebond.
            </p>
          </div>
        </>
      ) : (
        <div className="flow-panel">
          <div className="section-heading">
            <span>OBSERVATIONS DU TAPE</span>
          </div>
          <Badge tone="warning">Couverture partielle</Badge>
          {flow.isError && (
            <p className="notice">
              Source interrompue. Les observations précédentes restent
              consultables.
            </p>
          )}
          <h2>
            {flow.data?.bars.length ?? 0}
            <small> bougies reçues</small>
          </h2>
          <dl>
            <div>
              <dt>Contrat</dt>
              <dd>{flow.data?.contract || "Non résolu"}</dd>
            </div>
            <div>
              <dt>Unité</dt>
              <dd>{flow.data?.unit || "Inconnue"}</dd>
            </div>
            <div>
              <dt>Première observation</dt>
              <dd>
                {flow.data?.first_observed_ts
                  ? new Date(flow.data.first_observed_ts * 1000).toLocaleString(
                      "fr-FR",
                    )
                  : "Inconnue"}
              </dd>
            </div>
          </dl>
          {!flow.data?.available && (
            <Empty
              title={
                flow.isError ? "Source indisponible" : "Aucun flux collecté"
              }
            >
              {flow.isError
                ? "Réessayez après vérification de la connexion."
                : flow.data?.reason ||
                  "Les données apparaissent après réception du tape."}
            </Empty>
          )}
          <p className="muted">
            L’absorption est une estimation. Pour les options BTC : prime
            agressive / index stable, pas une preuve sur un carnet unique.
          </p>
          <button
            className="full-button"
            onClick={() => set({ dialog: "journal" })}
          >
            Ouvrir le journal <ChevronRight size={14} />
          </button>
        </div>
      )}
      <button
        className="legacy-link"
        onClick={() => set({ dialog: "advanced", advancedTab: "exposure" })}
      >
        Échéances, scénarios & outils <ArrowUpRight size={13} />
      </button>
    </aside>
  );
}
