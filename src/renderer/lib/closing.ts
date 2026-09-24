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

function nomDe(tabId: string): string {
  const tab = useWorkspace.getState().tabs.find((t) => t.id === tabId)
  return tab?.title ?? tabId.replace(/^file:/, "")
}

/**
 * Fermer un onglet, en demandant d'abord s'il porte des modifications.
 * Rend vrai quand l'onglet est fermé.
 */
export async function requestCloseTab(tabId: string): Promise<boolean> {
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
  if (brouillons.length === 0) return
  event.preventDefault()
  event.returnValue = false
  if (questionEnCours) return
  questionEnCours = true
  // Hors de l'événement : une boîte ouverte pendant qu'il se distribue ne
  // serait jamais dessinée.
  setTimeout(() => void demanderAvantDeFermer(brouillons.length), 0)
})

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
    fermetureAccordee = true
    window.close()
  } finally {
    questionEnCours = false
  }
}
