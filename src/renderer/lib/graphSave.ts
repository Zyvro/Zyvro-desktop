// Un graphe modifié ne part pas avant d'être enregistré.
//
// L'éditeur de graphe (le même composant que l'application web) enregistre
// tout seul, 1,2 s après la dernière modification. Fermer son onglet pendant
// ce délai le démontait, et son démontage annulait l'enregistrement en
// attente : la dernière modification était perdue, sans un mot. De même en
// quittant l'application.
//
// L'éditeur ne dit son état qu'à l'écran — le badge Saved / Saving / Unsaved de
// sa barre. On le lit là, plutôt que de changer un composant partagé avec le
// site : `scripts/check-graph-close.mjs` vérifie que le composant écrit
// toujours ces trois mots.

import { useWorkspace } from "~/state/workspace"
import { askConfirm } from "~/state/prompt"

export type GraphSave = "saved" | "saving" | "unsaved"

/** Le texte du badge, en état ; null pour autre chose. Pur. */
export function saveStateOf(text: string | null | undefined): GraphSave | null {
  const t = (text ?? "").trim()
  return t === "Saved" ? "saved" : t === "Saving" ? "saving" : t === "Unsaved" ? "unsaved" : null
}

// L'état d'un graphe ouvert. Pas de badge (l'éditeur charge encore, ou n'est
// pas monté) : rien à attendre.
export function graphSaveState(workflowId: string): GraphSave {
  const hote = document.querySelector(`[data-graph="${CSS.escape(workflowId)}"]`)
  if (!hote) return "saved"
  for (const span of hote.querySelectorAll("span")) {
    const etat = saveStateOf(span.textContent)
    if (etat) return etat
  }
  return "saved"
}

function workflowIdOf(tabId: string): string | null {
  const tab = useWorkspace.getState().tabs.find((t) => t.id === tabId)
  return tab?.kind === "graph" ? tab.workflowId : null
}

/** Les graphes, parmi ces onglets (tous si omis), qui ne sont pas encore enregistrés. */
export function unsavedGraphTabs(tabIds?: string[]): string[] {
  const ids = tabIds ?? useWorkspace.getState().tabs.map((t) => t.id)
  return ids.filter((id) => {
    const wf = workflowIdOf(id)
    return wf !== null && graphSaveState(wf) !== "saved"
  })
}

// Attendre que ces graphes soient enregistrés : l'enregistrement part au plus
// 1,2 s après la dernière modification ; au-delà de quelques secondes, il a
// échoué (le moteur ne répond pas, le disque refuse).
export async function waitGraphsSaved(tabIds: string[], ms = 5000): Promise<string[]> {
  const fin = Date.now() + ms
  let restants = unsavedGraphTabs(tabIds)
  while (restants.length > 0 && Date.now() < fin) {
    await new Promise((r) => setTimeout(r, 150))
    restants = unsavedGraphTabs(restants)
  }
  return restants
}

// graphsReadyToClose : vrai quand ces onglets peuvent partir sans rien perdre —
// leurs graphes enregistrés, ou la personne accepte de perdre ce qui ne l'a pas
// été.
export async function graphsReadyToClose(tabIds?: string[]): Promise<boolean> {
  const restants = await waitGraphsSaved(unsavedGraphTabs(tabIds))
  if (restants.length === 0) return true
  const noms = restants.map((id) => useWorkspace.getState().tabs.find((t) => t.id === id)?.title ?? id)
  const oui = await askConfirm({
    title: restants.length === 1 ? `${noms[0]} is not saved` : `${restants.length} workflows are not saved`,
    label: "Their last changes could not be saved yet. Close anyway and lose them?",
    confirmLabel: "Close Anyway",
    danger: true,
  })
  if (!oui) {
    useWorkspace.getState().activateTab(restants[0])
    return false
  }
  return true
}
