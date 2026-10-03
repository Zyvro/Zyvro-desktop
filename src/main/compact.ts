// `/compact` : quand le harnais a réduit le contexte.
//
// Même marqueur que `/goal` (goal.ts) : un événement **assistant** portant
// `local_command_run: {command: "compact"}`. Sans lui, il faudrait reconnaître
// une compaction au milieu de ce que le modèle écrit, et une réponse qui
// contiendrait « compacted » deviendrait une compaction.
//
// Ce que ce module rend :
//   null            cet événement n'est pas une compaction
//   { summary }     c'en est une, avec le texte que la CLI a imprimé
//
// Le résumé est ce que le harnais a écrit — pas un résumé qu'on invente. C'est
// lui qui devient le début du nouveau contexte, comme dans le TUI du harnais.

export type Compacted = { summary: string }

export function compactIn(event: Record<string, unknown>): Compacted | null {
  if (event.type !== "assistant") return null
  const run = (event.local_command_run && typeof event.local_command_run === "object"
    ? event.local_command_run
    : {}) as Record<string, unknown>
  if (run.command !== "compact") return null
  return { summary: commandText(event) }
}

// commandText : ce que la commande a imprimé, sans l'enveloppe de sortie
// locale. Copié de goal.ts : les deux lisent la même forme d'événement, et
// deux copies d'une règle de lecture finissent par diverger.
function commandText(event: Record<string, unknown>): string {
  const message = (event.message && typeof event.message === "object" ? event.message : {}) as Record<string, unknown>
  const blocs = Array.isArray(message.content) ? message.content : []
  const texte = blocs
    .map((b) => {
      const bloc = (b && typeof b === "object" ? b : {}) as Record<string, unknown>
      return bloc.type === "text" && typeof bloc.text === "string" ? bloc.text : ""
    })
    .join("")
    .trim()
  if (texte) return texte

  const brut = typeof event.local_command_source === "string" ? event.local_command_source : ""
  return brut.replace(/<\/?local-command-[a-z]+>/gi, "").trim()
}
