// Renommer et mettre à la corbeille une entrée de l'arbre.
//
// Deux chemins y mènent — le clic droit et le clavier (F2, Suppr) — et ils
// doivent faire exactement la même chose : demander, agir, relire le dossier,
// faire suivre les onglets. Deux copies de ces règles, c'est une des deux qui
// oublie la dernière.

import type { QueryClient } from "@tanstack/react-query"
import type { DirEntry } from "../../preload"
import { askConfirm, askName } from "~/state/prompt"
import { clearHeld, heldItem } from "~/state/clipboard"
import { useWorkspace } from "~/state/workspace"
import { isInside, parentOf } from "../../shared/treedrop"

// Relire le dossier qui contient ce qu'on vient de changer. L'arbre relit par
// sa version ; ici on invalide, parce que c'est nous qui avons bougé le disque
// et qu'attendre l'observateur ferait clignoter un nom qui n'existe plus.
export function reloadDir(client: QueryClient, dir: string): void {
  void client.invalidateQueries({ queryKey: ["files", "list", dir || "."] })
}

export async function renameEntry(entry: DirEntry, client: QueryClient): Promise<void> {
  const nom = await askName({
    title: "Rename",
    label: entry.path,
    confirmLabel: "Rename",
    initial: entry.name,
  })
  const propre = nom?.trim()
  if (!propre || propre === entry.name) return
  const parent = parentOf(entry.path)
  const vers = parent ? `${parent}/${propre}` : propre
  await window.zyvro.files.rename(entry.path, vers)
  useWorkspace.getState().movePath(entry.path, vers)
  reloadDir(client, parent)
}

// Supprimer demande, et ce qui part va à la corbeille.
//
// Les deux ensemble, parce qu'aucun des deux ne suffit : une confirmation
// seule fait dire oui à ce qu'on croit avoir visé, et une corbeille seule
// laisse un dossier disparaître d'un clic. La question nomme le chemin entier,
// pas seulement le fichier — c'est la seule façon de voir qu'on s'est trompé
// de ligne.
export async function trashEntry(entry: DirEntry, client: QueryClient): Promise<boolean> {
  const dossier = entry.kind === "directory"
  const oui = await askConfirm({
    title: dossier ? `Delete the folder ${entry.name}?` : `Delete ${entry.name}?`,
    label: dossier
      ? `${entry.path} and everything inside it moves to the trash.`
      : `${entry.path} moves to the trash.`,
    confirmLabel: "Move to trash",
  })
  if (!oui) return false
  await window.zyvro.files.remove(entry.path)
  reloadDir(client, parentOf(entry.path))
  // Ce qui part à la corbeille ne peut plus être collé. Le garder dans le
  // presse-papiers offrirait un « Paste "notes.txt" » qui échouerait par
  // « notes.txt is no longer there ». Un dossier supprimé emporte ce qu'il
  // contenait.
  const garde = heldItem()
  if (garde && isInside(garde.path, entry.path)) clearHeld()
  // Et ses onglets propres se ferment : un onglet sur un fichier parti à la
  // corbeille montre un texte que la sauvegarde suivante recréerait. Un onglet
  // modifié reste — ce qu'il contient n'existe plus nulle part ailleurs.
  const store = useWorkspace.getState()
  for (const tab of store.tabs) {
    if (tab.kind === "file" && isInside(tab.path, entry.path) && !(tab.id in store.drafts)) {
      useWorkspace.getState().closeTab(tab.id)
    }
  }
  return true
}
