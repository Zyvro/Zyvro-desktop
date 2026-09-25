// Le projet entier pour TypeScript : les définitions d'un fichier à l'autre.
//
// Les sources du projet (shared/projectIndex) deviennent des bibliothèques en
// plus pour le service TypeScript de Monaco : F12 et ⌘-clic sur un nom importé
// mènent à son fichier, « Go to References » voit tout le projet, et les
// imports relatifs cessent d'être « introuvables ». Un onglet ouvert passe
// devant sa copie : c'est son texte, brouillon compris, que TypeScript lit.
//
// Aller dans un autre fichier ouvre son onglet (et le montre à la bonne ligne)
// au lieu de rester dans l'éditeur courant : `registerEditorOpener`.
//
// Importé pour son effet, comme menuBridge.

import { modelUri, monaco, pathOfUri } from "./monaco"
import { useWorkspace } from "~/state/workspace"
import { revealAt } from "~/state/reveal"
import { subscribeFiles } from "~/state/fileWatch"
import { INDEX_MAX_FILE_BYTES, INDEX_MAX_TOTAL_BYTES, selectIndexable } from "../../shared/projectIndex"

let generation = 0
let minuterie: ReturnType<typeof setTimeout> | null = null

function poser(libs: { content: string; filePath: string }[]): void {
  monaco.languages.typescript.typescriptDefaults.setExtraLibs(libs)
  monaco.languages.typescript.javascriptDefaults.setExtraLibs(libs)
}

async function indexer(): Promise<void> {
  const gen = ++generation
  const { project } = useWorkspace.getState()
  if (!project) {
    poser([])
    return
  }
  const liste = await window.zyvro.files.all().catch(() => null)
  if (!liste || gen !== generation) return
  const choisis = selectIndexable(liste.files)
  const libs: { content: string; filePath: string }[] = []
  let total = 0
  // Par paquets : un millier de lectures d'un coup encombrerait le canal que
  // l'arbre et l'éditeur utilisent aussi.
  for (let i = 0; i < choisis.length; i += 24) {
    const paquet = choisis.slice(i, i + 24)
    const textes = await Promise.all(
      paquet.map((p) =>
        window.zyvro.files.read(p).then(
          (r) => ("text" in r ? r.text : null),
          () => null
        )
      )
    )
    if (gen !== generation) return
    for (let k = 0; k < paquet.length; k++) {
      const t = textes[k]
      if (t === null || t.length > INDEX_MAX_FILE_BYTES) continue
      if (total + t.length > INDEX_MAX_TOTAL_BYTES) break
      total += t.length
      libs.push({ content: t, filePath: modelUri(paquet[k]).toString() })
    }
  }
  if (gen === generation) poser(libs)
}

// Plus tard, et une seule fois pour une rafale : un agent qui écrit dix
// fichiers ne doit pas relire le projet dix fois.
function bientot(ms: number): void {
  if (minuterie) clearTimeout(minuterie)
  minuterie = setTimeout(() => {
    minuterie = null
    void indexer()
  }, ms)
}

let projetVu: string | null = null
useWorkspace.subscribe((s) => {
  const p = s.project?.project ?? null
  if (p === projetVu) return
  projetVu = p
  // L'ancien projet part tout de suite ; le nouveau vient après l'ouverture,
  // qui a mieux à faire que lire mille fichiers.
  generation++
  poser([])
  if (p) bientot(1500)
})
subscribeFiles(() => {
  if (useWorkspace.getState().project) bientot(10_000)
})

// Une définition dans un autre fichier : son onglet, à la bonne ligne.
monaco.editor.registerEditorOpener({
  openCodeEditor(_source, resource, selectionOrPosition) {
    const path = pathOfUri(resource)
    if (!path) return false
    // Monaco compte à partir de 1 ; `revealAt` à partir de 0. La définition
    // arrive sélectionnée — son nom — comme dans VS Code.
    const sel = selectionOrPosition
    const pos =
      sel && "startLineNumber" in sel
        ? {
            line: sel.startLineNumber - 1,
            column: sel.startColumn - 1,
            length: sel.endLineNumber === sel.startLineNumber ? Math.max(0, sel.endColumn - sel.startColumn) : 0,
          }
        : sel && "lineNumber" in sel
          ? { line: sel.lineNumber - 1, column: sel.column - 1, length: 0 }
          : { line: 0, column: 0, length: 0 }
    useWorkspace.getState().openFile(path)
    useWorkspace.getState().pinTab(`file:${path}`)
    revealAt({ path, ...pos })
    return true
  },
})
