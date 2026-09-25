// Qui sait enregistrer quel onglet.
//
// Chaque éditeur de fichier s'inscrit ici sous l'identifiant de son onglet, et
// c'est d'ici qu'on enregistre — un onglet, l'onglet actif, ou tous ceux qui
// ont un brouillon.
//
// Il fallait un registre parce que la commande Save du menu était écoutée par
// *tous* les éditeurs montés, et qu'ils le restent tous, onglet caché compris :
// ⌘S réécrivait chaque fichier ouvert, y compris ceux qu'on n'avait pas
// regardés depuis une heure et qu'un autre programme avait changés entre-temps.
// Enregistrer est un geste qui vise un fichier ; le registre le fait viser.

type Saver = () => Promise<boolean>

// Une pile par onglet : un fichier ouvert des deux côtés (⌘\) a deux
// éditeurs, sur le même texte. Le dernier inscrit enregistre ; fermer la vue
// de droite rend la main à celle de gauche au lieu de laisser l'onglet sans
// personne — ⌘S dirait alors « rien à faire » et n'écrirait rien.
const savers = new Map<string, Saver[]>()

/** L'éditeur d'un onglet s'inscrit ; la fonction rendue le désinscrit. */
export function registerSaver(tabId: string, save: Saver): () => void {
  savers.set(tabId, [...(savers.get(tabId) ?? []), save])
  return () => {
    const reste = (savers.get(tabId) ?? []).filter((s) => s !== save)
    if (reste.length > 0) savers.set(tabId, reste)
    else savers.delete(tabId)
  }
}

/**
 * Enregistrer un onglet. Vrai quand c'est fait — ou qu'il n'y avait rien à
 * faire : un onglet sans éditeur inscrit n'est pas un fichier.
 */
export async function saveTab(tabId: string): Promise<boolean> {
  const pile = savers.get(tabId)
  const save = pile?.[pile.length - 1]
  return save ? save() : true
}

/**
 * Enregistrer tous les onglets désignés, dans l'ordre. Rend ceux qui ont
 * échoué : un disque plein ou un fichier en lecture seule ne doit pas faire
 * croire que tout est parti.
 */
export async function saveTabs(tabIds: string[]): Promise<string[]> {
  const failed: string[] = []
  for (const id of tabIds) {
    if (!(await saveTab(id))) failed.push(id)
  }
  return failed
}
