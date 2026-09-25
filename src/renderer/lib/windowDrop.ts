// Ce qu'on lâche sur la fenêtre, là où aucun panneau ne l'a pris.
//
// L'arbre, le terminal et le chat ont chacun leur dépôt, et ils passent
// d'abord : ils appellent `preventDefault`, et ce module regarde
// `defaultPrevented` avant de faire quoi que ce soit. Ce qui reste est le
// geste qu'on fait dans VS Code sans y penser :
//
// - un **dossier** lâché sur la fenêtre s'ouvre comme projet ;
// - un **fichier**, d'où qu'il vienne, s'ouvre dans un onglet — épinglé, pas
//   en aperçu : trois fichiers lâchés font trois onglets. Hors du projet, il
//   s'ouvre quand même et s'enregistre à sa place, comme dans Cursor ; le
//   principal ne l'accorde qu'à cette fenêtre, et seulement parce qu'on l'a
//   lâché (shared/external). Le lâcher sur l'arbre, lui, le copie dedans.
//
// Importé pour son effet, comme `menuBridge` : les écouteurs s'installent une
// fois, au chargement, sans effet React.

import { useWorkspace } from "~/state/workspace"
import { askConfirm } from "~/state/prompt"
import { openProject } from "./project"

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
        file,
      }
    })
    .filter((lu) => lu.chemin)

  void agir(lus)
})

async function agir(lus: { dossier: boolean; chemin: string; file: File | null }[]): Promise<void> {
  const store = useWorkspace.getState()

  // Un seul dossier : c'est un projet à ouvrir. Plusieurs, on ne devine pas
  // lequel — l'application n'ouvre qu'un projet par fenêtre.
  const dossiers = lus.filter((lu) => lu.dossier)
  if (dossiers.length === 1 && lus.length === 1) {
    const cible = dossiers[0].chemin
    if (store.project?.project === cible) return
    if (store.project) {
      // Remplacer le projet ouvert ferme ses onglets ; les fichiers modifiés
      // sont demandés ensuite, un par un ou tous ensemble (openProject).
      const oui = await askConfirm({
        title: `Open ${cible.split(/[\\/]/).pop()}?`,
        label: "It replaces the open project in this window.",
        confirmLabel: "Open folder",
      })
      if (!oui) return
    }
    await openProject(cible)
    return
  }

  const fichiers = lus.filter((lu) => !lu.dossier && lu.file).map((lu) => lu.file as File)
  if (fichiers.length === 0) return
  openFiles(await window.zyvro.files.openDropped(fichiers))
}

/** Ouvrir des chemins d'onglet (relatifs ou absolus) épinglés, le dernier devant. */
export function openFiles(chemins: string[]): void {
  const store = useWorkspace.getState()
  for (const chemin of chemins) {
    store.openFile(chemin)
    store.pinTab(`file:${chemin}`)
  }
}
