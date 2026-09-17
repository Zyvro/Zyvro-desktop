import { useSyncExternalStore } from "react"
import { Sparkles } from "lucide-react"
import { cn } from "@/lib/utils"
import { completionEnabled, setCompletionEnabled, subscribeCompletion } from "~/lib/completion"

// L'interrupteur de la complétion en ligne.
//
// Dans la barre du bas, à côté de l'appareil photo, parce que c'est là qu'on
// range ce qui est toujours vrai d'une fenêtre plutôt que d'un fichier.
//
// Éteint tant que personne ne l'allume, et c'est le point : une complétion
// part à chaque silence de frappe, et chaque départ dépense le compte de
// quelqu'un. Un réglage qui coûte de l'argent ne s'allume pas tout seul.
export function CompletionToggle() {
  const on = useSyncExternalStore(subscribeCompletion, completionEnabled, () => false)
  return (
    <button
      type="button"
      onClick={() => setCompletionEnabled(!on)}
      title={
        on
          ? "Inline completion is on — suggestions appear after a pause, Tab accepts. Click to turn off."
          : "Inline completion is off. Click to turn it on; it asks your completion provider after each pause."
      }
      className={cn(
        "flex items-center gap-1 rounded px-1 transition-colors hover:text-foreground",
        on ? "text-primary" : "text-muted-foreground/70"
      )}
    >
      <Sparkles className="h-3 w-3" />
      <span className="hidden sm:inline">{on ? "completion" : "completion off"}</span>
    </button>
  )
}
