import { useSyncExternalStore } from "react"
import { Coins } from "lucide-react"
import { cn } from "@/lib/utils"
import { setUsageShown, subscribeUsage, usageShown } from "~/lib/usage"

// L'interrupteur des jetons dépensés.
//
// À côté de celui de la complétion, dans la barre du bas : c'est là que vit ce
// qui est vrai de la fenêtre plutôt que d'un fichier.
//
// Allumé tant que personne ne l'éteint, et c'est la différence avec la
// complétion : les chiffres viennent avec le flux du CLI, les afficher ne
// demande rien à personne et ne dépense rien. Ce qu'on éteint ici, c'est une
// ligne de plus sous chaque réponse, pas une facture.
export function UsageToggle() {
  const on = useSyncExternalStore(subscribeUsage, usageShown, () => true)
  return (
    <button
      type="button"
      onClick={() => setUsageShown(!on)}
      title={
        on
          ? "Token usage is shown under each answer — hover a line for the split between new, cached and written. Click to hide."
          : "Token usage is hidden. Click to show what each answer spent, in and out."
      }
      className={cn(
        "flex items-center gap-1 rounded px-1 transition-colors hover:text-foreground",
        on ? "text-primary" : "text-muted-foreground/70"
      )}
    >
      <Coins className="h-3 w-3" />
      <span className="hidden sm:inline">{on ? "tokens" : "tokens off"}</span>
    </button>
  )
}
