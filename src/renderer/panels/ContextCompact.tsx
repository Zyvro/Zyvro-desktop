import { Recycle } from "lucide-react"
import { cn } from "@/lib/utils"
import { contextPercentIn, contextTone, windowForThread } from "../../shared/context"
import { compact } from "~/lib/usage"
import { RAIL_BUTTON } from "./railButton"

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
  ranWith,
  hasCompact,
  disabled,
  onCompact,
}: {
  /** Jetons dans le contexte, tels que le dernier reçu les a mesurés. */
  context: number | null
  /** Le modèle épinglé, ou null. */
  model: string | null
  /** Celui qui a réellement tourné — c'est lui qui porte `[1m]` le cas échéant. */
  ranWith: string | null
  /** Le harnais sait-il `/compact` ? Sans ça, le clic n'aurait aucun effet. */
  hasCompact: boolean
  disabled?: boolean
  onCompact: () => void
}) {
  const fenetre = windowForThread(model, ranWith)
  const percent = contextPercentIn(context, fenetre)
  const tone = percent === null ? "calm" : contextTone(Math.min(100, percent))
  const over = percent !== null && percent > 100
  const title =
    context === null
      ? hasCompact
        ? "Compact context — frees room before a long task (runs /compact on the harness)"
        : "This harness has no /compact command"
      : !hasCompact
        ? `Context: ${compact(context)} tokens. This harness has no /compact command.`
        : percent === null
          ? `Context: ${compact(context)} tokens (window unknown). Click to compact (runs /compact).`
          : over
            ? `Context: over the window — ${compact(context)} / ${compact(fenetre!)} tokens. Click to compact.`
            : `Context: ${percent}% · ${compact(context)} / ${compact(fenetre!)} tokens. Click to compact before a long task.`

  // Dans la barre, pas de chiffre : un anneau autour de l'icône se remplit
  // avec la fenêtre, et le pourcentage exact est dans l'infobulle.
  const fill = percent === null ? null : Math.min(100, Math.max(0, percent))
  const R = 12
  const C = 2 * Math.PI * R
  return (
    <button
      type="button"
      title={title}
      aria-label="Compact context"
      disabled={disabled || !hasCompact}
      data-compact-trigger
      data-context-percent={percent ?? undefined}
      onClick={onCompact}
      className={cn(
        RAIL_BUTTON,
        tone === "hot" ? "text-red-300" : tone === "warm" ? "text-amber-300" : "text-muted-foreground hover:text-foreground"
      )}
    >
      <Recycle className="h-3.5 w-3.5 shrink-0" />
      {fill !== null && (
        <svg className="pointer-events-none absolute inset-0 h-full w-full -rotate-90" viewBox="0 0 28 28" aria-hidden>
          <circle cx="14" cy="14" r={R} fill="none" stroke="currentColor" strokeOpacity={0.15} strokeWidth={1.5} />
          <circle
            cx="14"
            cy="14"
            r={R}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeDasharray={`${(fill / 100) * C} ${C}`}
          />
        </svg>
      )}
    </button>
  )
}
