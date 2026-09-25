// Fermer sans perdre ce qu'on n'a pas enregistré.
//
// Deux portes par où partaient des modifications sans qu'on le demande :
//
// - **la croix d'un onglet modifié**, dont l'infobulle disait honnêtement
//   « Close without saving » — et qui le faisait ;
// - **la fenêtre elle-même** : ⌘Q, la croix rouge, un rechargement. Rien ne
//   demandait, et tous les brouillons partaient avec le rendu.
//
// Les deux posent maintenant la question de tout éditeur : Save, Don't Save,
// Cancel. Et un enregistrement qui échoue ne ferme rien — fermer après un
// échec, ce serait perdre précisément ce qu'on a demandé de garder.
//
// Importé pour son effet, comme `menuBridge`, pour l'écouteur de fermeture.

import { useWorkspace } from "~/state/workspace"
import { askChoice } from "~/state/prompt"
import { saveTab, saveTabs } from "~/state/savers"
import { graphsReadyToClose, unsavedGraphTabs } from "./graphSave"

function nomDe(tabId: string): string {
  const tab = useWorkspace.getState().tabs.find((t) => t.id === tabId)
  return tab?.title ?? tabId.replace(/^file:/, "")
}

/**
 * Fermer un onglet, en demandant d'abord s'il porte des modifications.
 * Rend vrai quand l'onglet est fermé.
 */
export async function requestCloseTab(tabId: string): Promise<boolean> {
  // Un graphe attend son enregistrement automatique avant de partir.
  if (!(await graphsReadyToClose([tabId]))) return false
  const store = useWorkspace.getState()
  if (!(tabId in store.drafts)) {
    store.closeTab(tabId)
    return true
  }
  const choix = await askChoice({
    title: `Save the changes to ${nomDe(tabId)}?`,
    label: "Your changes will be lost if you don't save them.",
    confirmLabel: "Save",
    alternativeLabel: "Don't Save",
  })
  if (choix === null) return false
  if (choix === "confirm" && !(await saveTab(tabId))) {
    // L'éditeur montre déjà pourquoi, sous son texte ; on le met devant.
    useWorkspace.getState().activateTab(tabId)
    return false
  }
  useWorkspace.getState().closeTab(tabId)
  return true
}

/** Enregistrer tout ce qui a un brouillon. Rend les onglets qui ont échoué. */
export function saveAll(): Promise<string[]> {
  return saveTabs(Object.keys(useWorkspace.getState().drafts))
}

// ---- la fenêtre -----------------------------------------------------------
//
// `beforeunload` est la seule prise qu'Electron donne au rendu sur la
// fermeture : lui rendre une valeur annule, en silence — pas de boîte du
// navigateur, c'est à nous de demander. On annule donc, on demande, puis on
// referme soi-même avec la permission levée.

let fermetureAccordee = false
let questionEnCours = false

window.addEventListener("beforeunload", (event) => {
  if (fermetureAccordee) return
  const brouillons = Object.keys(useWorkspace.getState().drafts)
  const graphes = unsavedGraphTabs()
  if (brouillons.length === 0 && graphes.length === 0) return
  event.preventDefault()
  event.returnValue = false
  if (questionEnCours) return
  questionEnCours = true
  // Hors de l'événement : une boîte ouverte pendant qu'il se distribue ne
  // serait jamais dessinée.
  setTimeout(() => void (brouillons.length > 0 ? demanderAvantDeFermer(brouillons.length) : fermerApresLesGraphes()), 0)
})

// Seulement des graphes en cours d'enregistrement : on attend qu'ils le
// soient — une seconde, d'habitude — puis on ferme, sans rien demander.
async function fermerApresLesGraphes(): Promise<void> {
  try {
    if (!(await graphsReadyToClose())) return
    fermetureAccordee = true
    window.close()
  } finally {
    questionEnCours = false
  }
}

async function demanderAvantDeFermer(combien: number): Promise<void> {
  try {
    const choix = await askChoice({
      title: combien === 1 ? "Save the changes to 1 file?" : `Save the changes to ${combien} files?`,
      label: "Your changes will be lost if you close without saving them.",
      confirmLabel: combien === 1 ? "Save" : "Save All",
      alternativeLabel: "Don't Save",
    })
    if (choix === null) return
    if (choix === "confirm") {
      const echecs = await saveAll()
      if (echecs.length > 0) {
        useWorkspace.getState().activateTab(echecs[0])
        return
      }
    }
    // Les fichiers réglés, les graphes aussi : attendre leur enregistrement.
    if (!(await graphsReadyToClose())) return
    fermetureAccordee = true
    window.close()
  } finally {
    questionEnCours = false
  }
}

// tabsToClose : ce que désignent Close Others, Close to the Right et Close All,
// dans l'ordre de la barre. Pur, pour le vérifier sans fenêtre.
export function tabsToClose(
  tabIds: string[],
  target: string,
  which: "others" | "right" | "all"
): string[] {
  if (which === "all") return [...tabIds]
  if (which === "others") return tabIds.filter((id) => id !== target)
  const i = tabIds.indexOf(target)
  return i < 0 ? [] : tabIds.slice(i + 1)
}

/**
 * Fermer plusieurs onglets. Une seule question pour tous ceux qui ont des
 * modifications, comme VS Code — vingt boîtes à la suite pour « Close All »,
 * c'est vingt occasions de cliquer le mauvais bouton. Rend vrai quand tout est
 * fermé.
 */
export async function requestCloseTabs(tabIds: string[]): Promise<boolean> {
  if (!(await graphsReadyToClose(tabIds))) return false
  const store = useWorkspace.getState()
  const modifies = tabIds.filter((id) => id in store.drafts)
  if (modifies.length === 1) {
    // Un seul : la question habituelle, avec son nom.
    for (const id of tabIds) if (!(id in store.drafts)) store.closeTab(id)
    return requestCloseTab(modifies[0])
  }
  if (modifies.length > 1) {
    const choix = await askChoice({
      title: `Save the changes to ${modifies.length} files?`,
      label: modifies.map(nomDe).join(", "),
      confirmLabel: "Save All",
      alternativeLabel: "Don't Save",
    })
    if (choix === null) return false
    if (choix === "confirm") {
      const echecs = await saveTabs(modifies)
      if (echecs.length > 0) {
        // Ce qui a été enregistré se ferme ; ce qui a échoué reste, devant.
        for (const id of tabIds) if (!echecs.includes(id)) useWorkspace.getState().closeTab(id)
        useWorkspace.getState().activateTab(echecs[0])
        return false
      }
    }
  }
  for (const id of tabIds) useWorkspace.getState().closeTab(id)
  return true
}
