// Ce qu'on lâche sur la fenêtre, là où aucun panneau ne l'a pris.
//
// L'arbre, le terminal et le chat ont chacun leur dépôt, et ils passent
// d'abord : ils appellent `preventDefault`, et ce module regarde
// `defaultPrevented` avant de faire quoi que ce soit. Ce qui reste est le
// geste qu'on fait dans VS Code sans y penser :
//
// - un **dossier** lâché sur la fenêtre s'ouvre comme projet ;
// - un **fichier du projet** lâché sur l'éditeur s'ouvre dans un onglet.
//
// Un fichier hors du projet n'est pas ouvert : l'éditeur ne lit que dans le
// projet, par le même portail que tout le reste, et ce n'est pas un dépôt qui
// doit y percer un trou. Le lâcher sur l'arbre le copie dedans.
//
// Importé pour son effet, comme `menuBridge` : les écouteurs s'installent une
// fois, au chargement, sans effet React.

import { useWorkspace } from "~/state/workspace"
import { askConfirm } from "~/state/prompt"
import { openProject } from "./project"
import { relativeInside } from "../../shared/treedrop"

function porteDesFichiers(event: DragEvent): boolean {
  return Boolean(event.dataTransfer && [...event.dataTransfer.types].includes("Files"))
}

window.addEventListener("dragover", (event) => {
  if (event.defaultPrevented || !porteDesFichiers(event)) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy"
})

window.addEventListener("drop", (event) => {
  if (event.defaultPrevented || !porteDesFichiers(event) || !event.dataTransfer) return
  event.preventDefault()

  // Lu tout de suite : les `items` d'un dépôt ne vivent que le temps de
  // l'événement, et `webkitGetAsEntry` est la seule façon de savoir qu'un
  // `File` est un dossier.
  const lus = [...event.dataTransfer.items]
    .filter((item) => item.kind === "file")
    .map((item) => {
      const file = item.getAsFile()
      return {
        dossier: Boolean(item.webkitGetAsEntry?.()?.isDirectory),
        chemin: file ? window.zyvro.files.droppedPath(file) : "",
      }
    })
    .filter((lu) => lu.chemin)

  void agir(lus)
})

async function agir(lus: { dossier: boolean; chemin: string }[]): Promise<void> {
  const store = useWorkspace.getState()

  // Un seul dossier : c'est un projet à ouvrir. Plusieurs, on ne devine pas
  // lequel — l'application n'ouvre qu'un projet par fenêtre.
  const dossiers = lus.filter((lu) => lu.dossier)
  if (dossiers.length === 1 && lus.length === 1) {
    const cible = dossiers[0].chemin
    if (store.project?.project === cible) return
    if (store.project) {
      // Remplacer le projet ouvert ferme ses onglets ; le dire avant, surtout
      // quand il reste des modifications non enregistrées.
      const nonEnregistres = Object.keys(store.drafts).length
      const oui = await askConfirm({
        title: `Open ${cible.split(/[\\/]/).pop()}?`,
        label:
          nonEnregistres > 0
            ? `It replaces the open project, and ${nonEnregistres} unsaved file${nonEnregistres > 1 ? "s" : ""} would be lost.`
            : "It replaces the open project in this window.",
        confirmLabel: "Open folder",
      })
      if (!oui) return
    }
    await openProject(cible)
    return
  }

  const racine = store.project?.project
  if (!racine) return
  for (const lu of lus) {
    if (lu.dossier) continue
    const relatif = relativeInside(racine, lu.chemin, window.zyvro.platform)
    if (relatif) store.openFile(relatif)
  }
}
