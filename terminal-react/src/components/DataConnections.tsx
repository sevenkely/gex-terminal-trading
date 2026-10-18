import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Badge } from "./UI";
interface SourceStatus {
  demo: boolean;
  ready_symbols: string[];
  attempts: {
    provider: string;
    symbol: string;
    checked_at: number;
    ok: boolean;
    error: string | null;
    last_success: number | null;
  }[];
  feeds: Record<string, { state: string }>;
  providers: {
    name: string;
    hosts: string[];
    transport: string;
    coverage: string;
  }[];
  guidance: string;
}
export function useSourceStatus() {
  return useQuery({
    queryKey: ["data-status"],
    queryFn: ({ signal }) => api<SourceStatus>("/api/data-status", signal),
    refetchInterval: 15000,
  });
}
interface AdminConfig {
  user?: string;
  system_name?: string;
  url?: string;
  app_name?: string;
  enabled?: boolean;
  auto_connect?: boolean;
  mappings?: Record<
    string,
    { exchange?: string; contract?: string; mode?: string }
  >;
}
interface AdminResponse {
  config?: AdminConfig;
  status?: { state: string; message?: string };
  presets?: {
    label?: string;
    name?: string;
    url: string;
    system_name?: string;
  }[];
}
function Administration() {
  const [token, setToken] = useState(""),
    [config, setConfig] = useState<AdminConfig | null>(null),
    [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [status, setStatus] = useState("");
  async function request(path: string, body?: unknown) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/rithmic" + path, {
        method: body === undefined ? "GET" : "POST",
        credentials: "same-origin",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok)
        throw Error(
          response.status === 401
            ? "Administration verrouillée. Vérifiez le jeton local GEX_ADMIN_TOKEN."
            : response.status === 403
              ? "Origine refusée. Vérifiez la configuration du serveur."
              : "Opération refusée (" + response.status + ").",
        );
      const value: AdminResponse = await response.json();
      if (value.config) {
        const c = value.config;
        setConfig({
          user: c.user,
          system_name: c.system_name,
          url: c.url,
          app_name: c.app_name,
          enabled: c.enabled,
          auto_connect: c.auto_connect,
          mappings: Object.fromEntries(
            Object.entries(c.mappings || {}).map(([sym, m]) => [
              sym,
              { exchange: m.exchange, contract: m.contract, mode: m.mode },
            ]),
          ),
        });
      }
      if (value.status)
        setStatus(value.status.state + " · " + (value.status.message || ""));
      setMessage("Opération confirmée par le serveur.");
      return value;
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Administration indisponible",
      );
    } finally {
      setBusy(false);
      setPassword("");
    }
  }
  return (
    <section className="admin-section">
      <h3>Market data Rithmic · optionnel</h3>
      <p className="fine-print">
        Connexion données uniquement, aucun passage d’ordres. Ne renseignez rien
        si vous utilisez les sources publiques. Jeton admin et mot de passe
        gardés en mémoire le temps de ce panneau ; jamais stockés dans le
        navigateur. Le serveur conserve sa configuration selon sa politique
        existante.
      </p>
      <form
        className="tools-controls"
        onSubmit={(e) => {
          e.preventDefault();
          void request("");
        }}
      >
        <label className="field">
          Jeton d’administration
          <input
            aria-label="Jeton administration données"
            required
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              setConfig(null);
            }}
          />
        </label>
        <button disabled={busy} type="submit">
          Charger la configuration protégée
        </button>
        {config && (
          <button
            type="button"
            onClick={() => {
              setToken("");
              setConfig(null);
              setPassword("");
              setStatus("");
              setMessage("");
            }}
          >
            Verrouiller le panneau
          </button>
        )}
      </form>
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      {config && (
        <>
          <p className="notice">État fournisseur : {status || "non vérifié"}</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void request("/config", {
                ...config,
                ...(password ? { password } : {}),
                enabled: config.enabled === true,
                auto_connect: config.auto_connect === true,
              });
            }}
          >
            <div className="settings-fields">
              {(["user", "system_name", "url", "app_name"] as const).map(
                (key) => (
                  <label className="field" key={key}>
                    {
                      {
                        user: "Identifiant market data",
                        system_name: "Système Rithmic",
                        url: "Gateway TLS (wss)",
                        app_name: "Nom application",
                      }[key]
                    }
                    <input
                      aria-label={"Rithmic " + key}
                      value={config[key] || ""}
                      onChange={(e) =>
                        setConfig({ ...config, [key]: e.target.value })
                      }
                    />
                  </label>
                ),
              )}
              <label className="field">
                Mot de passe market data (laisser vide pour conserver)
                <input
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
            </div>
            <div className="tools-controls">
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={config.auto_connect === true}
                  onChange={(e) =>
                    setConfig({ ...config, auto_connect: e.target.checked })
                  }
                />
                Reconnexion automatique autorisée
              </label>
            </div>
            <h4>Contrats et mapping</h4>
            {Object.entries(config.mappings || {}).map(([sym, mapping]) => (
              <div className="tools-controls" key={sym}>
                <strong>{sym}</strong>
                {(["exchange", "contract"] as const).map((key) => (
                  <label className="field" key={key}>
                    {key === "exchange" ? "Place" : "Contrat"}
                    <input
                      aria-label={`${sym} ${key}`}
                      value={mapping[key] || ""}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          mappings: {
                            ...config.mappings,
                            [sym]: { ...mapping, [key]: e.target.value },
                          },
                        })
                      }
                    />
                  </label>
                ))}
                <label className="field">
                  Type de prix
                  <select
                    value={mapping.mode || "direct"}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        mappings: {
                          ...config.mappings,
                          [sym]: { ...mapping, mode: e.target.value },
                        },
                      })
                    }
                  >
                    <option value="direct">Direct</option>
                    <option value="anchor">Proxy / ancré</option>
                  </select>
                </label>
              </div>
            ))}
            <div className="tools-controls">
              <button className="primary" type="submit" disabled={busy}>
                Enregistrer la configuration
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (
                    confirm(
                      "Connecter uniquement le flux market data configuré ?",
                    )
                  )
                    void request("/connect", {});
                }}
              >
                Connecter les données
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void request("/disconnect", {})}
              >
                Déconnecter
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void request("")}
              >
                Actualiser l’état
              </button>
            </div>
          </form>
        </>
      )}
    </section>
  );
}
export function DataConnections() {
  const query = useSourceStatus(),
    data = query.data;
  return (
    <>
      <div className="tools-controls">
        <Badge tone={data?.ready_symbols.length ? "positive" : "warning"}>
          {data?.ready_symbols.length
            ? `${data.ready_symbols.length} actifs avec chaîne`
            : "Aucune chaîne reçue"}
        </Badge>
        <Badge tone={data?.demo ? "warning" : "neutral"}>
          {data?.demo
            ? "Simulation explicitement activée"
            : "Sources réelles · aucun fallback SIM"}
        </Badge>
        <button
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          Actualiser le diagnostic
        </button>
      </div>
      {query.isError && (
        <p role="alert" className="notice">
          Diagnostic indisponible. Vérifiez que le backend à jour est démarré.
        </p>
      )}
      {query.isPending && <p role="status">Chargement du diagnostic…</p>}
      {data && (
        <>
          <p className="fine-print">{data.guidance}</p>
          <div className="table-scroll">
            <table>
              <caption>Sources nécessaires au fonctionnement</caption>
              <thead>
                <tr>
                  <th>Fournisseur</th>
                  <th>Domaines à autoriser</th>
                  <th>Transport</th>
                  <th>Couverture</th>
                </tr>
              </thead>
              <tbody>
                {data.providers.map((p) => (
                  <tr key={p.name}>
                    <th scope="row">{p.name}</th>
                    <td>{p.hosts.join(", ")}</td>
                    <td>{p.transport}</td>
                    <td>{p.coverage}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3 className="tool-section">Dernières tentatives du serveur</h3>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Actif</th>
                  <th>Vérification UTC</th>
                  <th>Résultat</th>
                  <th>Dernier succès UTC</th>
                </tr>
              </thead>
              <tbody>
                {data.attempts.map((a) => (
                  <tr key={a.provider + a.symbol}>
                    <td>{a.provider}</td>
                    <td>{a.symbol}</td>
                    <td>{new Date(a.checked_at * 1000).toISOString()}</td>
                    <td>
                      <Badge tone={a.ok ? "positive" : "warning"}>
                        {a.ok ? "Reçu" : a.error || "Échec réseau"}
                      </Badge>
                    </td>
                    <td>
                      {a.last_success
                        ? new Date(a.last_success * 1000).toISOString()
                        : "Jamais observé"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!data.attempts.length && (
            <p className="notice">
              Les premières tentatives sont en cours. « Serveur démarré » ne
              signifie pas « source disponible ».
            </p>
          )}
          <div className="tools-metrics">
            {Object.entries(data.feeds).map(([key, value]) => (
              <span key={key}>
                {key}
                <strong>{value.state}</strong>
              </span>
            ))}
          </div>
        </>
      )}
      <Administration />
    </>
  );
}
