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
import { symbolsFrom, type WsSymbol } from "../../shared/workspaceSymbols"
import type { NavTree } from "../../shared/outline"

let generation = 0
let minuterie: ReturnType<typeof setTimeout> | null = null

// Ce qui est indexé, fichier par fichier : la matière de ⌘T.
let indexes: { path: string; text: string }[] = []
// Gardés pour l'index qui les a donnés : une nouvelle indexation (`poser`)
// les oublie. Pas le compteur de `generation`, qui bouge dès qu'une
// indexation COMMENCE — et le projet s'écrit lui-même au démarrage.
let symboles: { de: typeof indexes; promesse: Promise<WsSymbol[]> } | null = null

function poser(libs: { content: string; filePath: string; path?: string }[]): void {
  monaco.languages.typescript.typescriptDefaults.setExtraLibs(libs.map(({ content, filePath }) => ({ content, filePath })))
  monaco.languages.typescript.javascriptDefaults.setExtraLibs(libs.map(({ content, filePath }) => ({ content, filePath })))
  indexes = libs.flatMap((l) => (l.path ? [{ path: l.path, text: l.content }] : []))
  symboles = null
}

// Le service d'une langue. Monaco ne le démarre qu'à la naissance du premier
// modèle de cette langue : sans fichier TypeScript ouvert, le demander échoue
// (« TypeScript not registered »). Un modèle vide, le temps de l'éveiller.
async function ouvrirService(langue: "typescript" | "javascript") {
  const obtenir = () =>
    langue === "typescript" ? monaco.languages.typescript.getTypeScriptWorker() : monaco.languages.typescript.getJavaScriptWorker()
  try {
    return await (await obtenir())()
  } catch {
    const eveil = monaco.editor.createModel("", langue)
    try {
      return await (await obtenir())()
    } finally {
      eveil.dispose()
    }
  }
}

// workspaceSymbols : les symboles de tout le projet indexé (⌘T), calculés au
// premier appel après chaque indexation, puis gardés. L'arbre de navigation de
// chaque fichier, par le service de sa langue.
export function workspaceSymbols(): Promise<WsSymbol[]> {
  if (symboles && symboles.de === indexes) return symboles.promesse
  const fichiers = indexes
  const promesse = (async () => {
    const ts = await ouvrirService("typescript")
    const js = await ouvrirService("javascript")
    const out: WsSymbol[] = []
    for (let i = 0; i < fichiers.length; i += 16) {
      const paquet = fichiers.slice(i, i + 16)
      const arbres = await Promise.all(
        paquet.map(({ path }) => {
          const client = /\.[cm]?jsx?$/i.test(path) ? js : ts
          return (client.getNavigationTree(modelUri(path).toString()) as Promise<NavTree | undefined>).catch(() => undefined)
        })
      )
      paquet.forEach(({ path, text }, k) => {
        const arbre = arbres[k]
        if (arbre) out.push(...symbolsFrom(path, arbre, text))
      })
    }
    return out
  })()
  symboles = { de: fichiers, promesse }
  return promesse
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
  const libs: { content: string; filePath: string; path: string }[] = []
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
      libs.push({ content: t, filePath: modelUri(paquet[k]).toString(), path: paquet[k] })
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
