import { ContextCompact } from "~/panels/ContextCompact"
import type { AgentPlugin } from "./types"

// Recycler le contexte avant une longue tâche : le pourcentage dit où en est la
// fenêtre du modèle, un clic lance `/compact` sur le harnais pour retomber bas
// et ne pas tomber sur une compaction automatique en plein milieu d'une grosse
// feature. Éteint, la jauge part ; `/compact` tapé à la main marche toujours,
// c'est une commande du harnais.
export const compactPlugin: AgentPlugin = {
  id: "compact",
  Rail: ({ ctx }) => (
    <ContextCompact
      context={ctx.thread.context}
      model={ctx.thread.model}
      ranWith={ctx.thread.ranWith}
      hasCompact={ctx.commands.some((n) => n.toLowerCase() === "compact")}
      disabled={ctx.disabled || ctx.thread.busy || !ctx.thread.started}
      onCompact={ctx.actions.compact}
    />
  ),
}
