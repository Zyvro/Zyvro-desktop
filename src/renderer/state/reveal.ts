// Ouvrir un fichier *à un endroit*.
//
// Un résultat de recherche n'est pas un fichier, c'est une ligne dans un
// fichier. Le magasin des onglets sait ouvrir le fichier ; il ne sait pas où
// poser le curseur, et l'éditeur qui le saurait n'existe pas encore au moment
// où on clique.
//
// D'où cette boîte aux lettres : la recherche y dépose une demande, l'éditeur
// la prend quand il est prêt — qu'il vienne de naître ou qu'il soit déjà là.

export type Reveal = { path: string; line: number; column: number; length: number }

let pending: Reveal | null = null
const listeners = new Set<() => void>()

export function revealAt(request: Reveal): void {
  pending = request
  for (const listener of listeners) listener()
}

// takeReveal consomme la demande si elle est pour ce fichier.
//
// Consommée, parce qu'une demande qui resterait ferait sauter le curseur à
// chaque fois qu'on revient sur l'onglet, longtemps après qu'on a cliqué.
export function takeReveal(path: string): Reveal | null {
  if (!pending || pending.path !== path) return null
  const request = pending
  pending = null
  return request
}

export function subscribeReveal(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// Le curseur dans le champ de recherche.
//
// Même forme, même raison : ⇧⌘F ouvre le panneau, et le panneau n'existe pas
// encore au moment où la touche est lue. Un compteur plutôt qu'un drapeau, pour
// que deux demandes de suite se remarquent.
let focusRequests = 0
const focusListeners = new Set<() => void>()

export function askSearchFocus(): void {
  focusRequests++
  for (const listener of focusListeners) listener()
}

export function searchFocusCount(): number {
  return focusRequests
}

export function subscribeSearchFocus(listener: () => void): () => void {
  focusListeners.add(listener)
  return () => focusListeners.delete(listener)
}
