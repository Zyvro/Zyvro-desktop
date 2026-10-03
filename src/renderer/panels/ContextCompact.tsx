import { Recycle } from "lucide-react"
import { cn } from "@/lib/utils"
import { contextPercent, contextTone, contextWindow } from "../../shared/context"
import { compact } from "~/lib/usage"

// Recycler le contexte, à côté de l'auto-synthèse : là où l'on écrit.
//
// Le pourcentage dit combien de la fenêtre du modèle la conversation occupe.
// Un clic lance `/compact` sur le harnais — une commande locale, pas une
// question au modèle — pour retomber bas avant une longue tâche et ne pas
// tomber sur une compaction automatique en plein milieu.
//
// Le chiffre ne s'invente pas : quand la fenêtre du modèle est inconnue, le
// bouton montre la taille en jetons et non un pourcentage au hasard.

export function ContextCompact({
  context,
  model,
  disabled,
  onCompact,
}: {
  /** Jetons dans le contexte, tels que le dernier reçu les a mesurés. */
  context: number | null
  /** Le modèle épinglé, ou celui que le CLI a fait tourner. */
  model: string | null
  disabled?: boolean
  onCompact: () => void
}) {
  const percent = contextPercent(context, model)
  const fenetre = contextWindow(model)
  const tone = percent === null ? "calm" : contextTone(percent)
  const title =
    context === null
      ? "Compact context — frees room before a long task (runs /compact on the harness)"
      : percent === null
        ? `Context: ${compact(context)} tokens${fenetre ? "" : " (window unknown)"}. Click to compact (runs /compact).`
        : `Context: ${percent}% · ${compact(context)} / ${compact(fenetre!)} tokens. Click to compact before a long task.`

  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      data-compact-trigger
      onClick={onCompact}
      className={cn(
        "mb-[1px] flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-[11px] outline-none hover:bg-white/[0.08] disabled:opacity-40",
        tone === "hot" ? "text-red-300" : tone === "warm" ? "text-amber-300" : "text-muted-foreground hover:text-foreground"
      )}
    >
      <Recycle className="h-3.5 w-3.5 shrink-0" />
      {percent !== null ? (
        <span className="tabular-nums">{percent}%</span>
      ) : context != null ? (
        <span className="hidden sm:inline tabular-nums">{compact(context)}</span>
      ) : null}
    </button>
  )
}
