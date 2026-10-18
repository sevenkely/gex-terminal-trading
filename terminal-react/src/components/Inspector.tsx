import { BookOpen, History, MousePointer2 } from "lucide-react";
import { useFlow } from "../hooks/useData";
import { useWorkspace } from "../lib/store";
import { compact } from "../lib/api";
import { useInspection } from "../lib/inspection";
export function Inspector() {
  const query = useFlow(),
    set = useWorkspace((s) => s.set),
    symbol = useWorkspace((s) => s.symbol),
    source = useWorkspace((s) => s.source),
    time = useInspection((s) => s.time);
  const bars = query.data?.bars || [],
    row = time == null ? undefined : bars.find((bar) => bar.t === time);
  const unit = query.data?.unit || "unité inconnue";
  const absorption = row ? row.abs_buy + row.abs_sell : undefined;
  return (
    <section className="inspector" aria-label="Inspecteur de bougie">
      <header>
        <div>
          <MousePointer2 size={13} />
          <strong>INSPECTEUR</strong>
          <span>
            {time
              ? new Date(time * 1000).toLocaleString("fr-FR", {
                  timeZone: "UTC",
                }) + " UTC"
              : "Survolez une bougie pour inspecter son flux"}
          </span>
        </div>
        <div>
          <button onClick={() => set({ dialog: "journal" })}>
            <BookOpen size={13} />
            Journal
          </button>
          <button onClick={() => set({ dialog: "replay" })}>
            <History size={13} />
            Relecture GEX
          </button>
        </div>
      </header>
      <div className="inspector-metrics">
        {[
          ["Gros trades", row?.big_total, row?.big_n],
          ["Absorption estimée", absorption, row?.abs_n],
          ["Delta agressif", row?.delta, null],
        ].map(([label, value, count]) => (
          <div key={label as string}>
            <span>{label}</span>
            <strong>
              {typeof value === "number" ? compact(value) : "—"}
              <small>{typeof value === "number" ? unit : "non collecté"}</small>
            </strong>
            {typeof count === "number" && <em>{count} événements</em>}
          </div>
        ))}
        <p>
          {query.isError ? "Source indisponible. " : ""}
          {bars.length} bougies reçues · historique partiel.
          <br />
          {!row
            ? "Inconnu sur cette bougie, pas zéro."
            : symbol === "BTC" && source === "options"
              ? "Prime / index stable : heuristique."
              : "Valeurs agrégées sur la bougie sélectionnée."}
        </p>
      </div>
    </section>
  );
}
