// Les problèmes que Monaco trouve dans les fichiers ouverts : erreurs de
// syntaxe, de types, avertissements.
//
// Comme VS Code sans compilation de tout le projet : ce que les services de
// langue voient, c'est-à-dire les fichiers ouverts. Recalculé à chaque
// changement de marqueurs, rendu comme une liste triée — les erreurs d'abord,
// puis par fichier et par ligne.

import { monaco, pathOfUri } from "~/lib/monaco"

export type Problem = {
  path: string
  severity: "error" | "warning" | "info"
  message: string
  line: number
  column: number
  source: string
}

export function severityOf(s: number): Problem["severity"] | null {
  if (s === monaco.MarkerSeverity.Error) return "error"
  if (s === monaco.MarkerSeverity.Warning) return "warning"
  if (s === monaco.MarkerSeverity.Info) return "info"
  return null // les simples indices ne sont pas des problèmes
}

const RANG = { error: 0, warning: 1, info: 2 } as const

let liste: Problem[] = []
const listeners = new Set<() => void>()

function recalculer(): void {
  const out: Problem[] = []
  for (const m of monaco.editor.getModelMarkers({})) {
    const path = pathOfUri(m.resource)
    const severity = severityOf(m.severity)
    if (!path || !severity) continue
    out.push({
      path,
      severity,
      message: m.message,
      line: m.startLineNumber,
      column: m.startColumn,
      source: m.source ?? m.owner,
    })
  }
  out.sort(
    (a, b) => RANG[a.severity] - RANG[b.severity] || a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column
  )
  liste = out
  for (const l of listeners) l()
}

monaco.editor.onDidChangeMarkers(recalculer)
// Un modèle fermé emporte ses marqueurs sans toujours le dire.
monaco.editor.onWillDisposeModel(() => queueMicrotask(recalculer))

export const problems = (): Problem[] => liste
export function subscribeProblems(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}
