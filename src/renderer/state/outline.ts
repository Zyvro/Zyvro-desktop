// L'Outline du fichier qu'on regarde (shared/outline), recalculé quand on
// change d'onglet ou qu'on tape — pas à chaque touche : une demi-seconde après.
//
// TypeScript et JavaScript : l'arbre de navigation du service TypeScript de
// Monaco, celui qui sert déjà à Go to Symbol. Markdown : ses titres. Le reste :
// rien, et la section le dit.

import { modelUri, monaco } from "~/lib/monaco"
import { focusedTabId, useWorkspace } from "~/state/workspace"
import { fromNavigationTree, markdownOutline, type NavTree, type OutlineItem } from "../../shared/outline"

export type OutlineState = { path: string | null; items: OutlineItem[]; supported: boolean }

let etat: OutlineState = { path: null, items: [], supported: false }
const listeners = new Set<() => void>()
export const outlineState = (): OutlineState => etat
export function subscribeOutline(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}
function poser(e: OutlineState): void {
  etat = e
  for (const l of listeners) l()
}

let suivi: { path: string; off: monaco.IDisposable } | null = null
let minuterie: ReturnType<typeof setTimeout> | null = null
let generation = 0

async function calculer(path: string): Promise<void> {
  const gen = ++generation
  const model = monaco.editor.getModel(modelUri(path))
  if (!model) {
    poser({ path, items: [], supported: false })
    return
  }
  const langue = model.getLanguageId()
  if (langue === "markdown") {
    poser({ path, items: markdownOutline(model.getValue()), supported: true })
    return
  }
  if (langue !== "typescript" && langue !== "javascript") {
    poser({ path, items: [], supported: false })
    return
  }
  try {
    const obtenir =
      langue === "typescript"
        ? await monaco.languages.typescript.getTypeScriptWorker()
        : await monaco.languages.typescript.getJavaScriptWorker()
    const client = await obtenir(model.uri)
    const arbre = (await client.getNavigationTree(model.uri.toString())) as NavTree | undefined
    if (gen !== generation || model.isDisposed()) return
    const items = arbre
      ? fromNavigationTree(arbre, (offset) => {
          const p = model.getPositionAt(offset)
          return { line: p.lineNumber, column: p.column }
        })
      : []
    poser({ path, items, supported: true })
  } catch {
    if (gen === generation) poser({ path, items: [], supported: true })
  }
}

function plusTard(path: string, ms: number): void {
  if (minuterie) clearTimeout(minuterie)
  minuterie = setTimeout(() => {
    minuterie = null
    void calculer(path)
  }, ms)
}

// Le fichier regardé, et ses modifications. Le modèle naît parfois après
// l'onglet (l'éditeur attend le texte) : on réessaie un peu plus tard.
function suivre(): void {
  const id = focusedTabId()
  const path = id.startsWith("file:") ? id.slice(5) : null
  if (suivi && suivi.path === path) {
    if (monaco.editor.getModel(modelUri(suivi.path))) return
  }
  suivi?.off.dispose()
  suivi = null
  if (!path) {
    poser({ path: null, items: [], supported: false })
    return
  }
  const model = monaco.editor.getModel(modelUri(path))
  if (!model) {
    poser({ path, items: [], supported: true })
    setTimeout(suivre, 400)
    return
  }
  suivi = { path, off: model.onDidChangeContent(() => plusTard(path, 500)) }
  void calculer(path)
}

let dernier = ""
useWorkspace.subscribe((s) => {
  const id = focusedTabId(s)
  if (id === dernier) return
  dernier = id
  suivre()
})
